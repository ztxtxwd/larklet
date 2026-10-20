import { Banner, Breadcrumb, Button, Card, Dropdown, Empty, Nav, Spin, Toast, Typography } from '@douyinfe/semi-ui';
import { useEffect, useState, type ReactNode } from 'react';

const H5_SDK = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.40.js';
const SEND_SCOPES = ['im:message', 'im:message.send_as_user'];

interface PageConfig {
  appId: string;
  allowDirectMessageId: boolean;
  title: string;
  previewUrl?: string;
  localPreview?: boolean;
}

interface CardInfo {
  messageId: string;
  title: string;
}

interface UserAuth {
  accessToken: string;
  expiresAt: number;
}

interface ChatPick {
  chatId: string;
  name: string;
}

interface ListedApp {
  href: string;
  title: string;
  description: string;
  intro?: string;
}

export interface AppDetailContext {
  app: ListedApp;
  chatId: string;
  appId: string;
  inFeishu: boolean;
  /** 浏览器直接打开、并且配置了 Larklet 预览地址。发送走模拟群，不打飞书。 */
  preview: boolean;
  /** 弹出飞书选会话。用户取消时返回 null。 */
  chooseTargetChat: () => Promise<{ chatId: string; name: string } | null>;
}

interface AppDetailRegistration {
  title: string;
  description?: string;
  render: (ctx: AppDetailContext) => ReactNode;
}

const appDetails = new Map<string, AppDetailRegistration>();

/** 某个应用在加号菜单里用自己的详情页，而不是一段介绍加「发送」。 */
export function registerAppDetail(href: string, detail: AppDetailRegistration): void {
  appDetails.set(href, detail);
}

function registeredDetail(href: string): AppDetailRegistration | undefined {
  return appDetails.get(href);
}

interface JsapiError {
  errno?: number;
  errCode?: number;
  errString?: string;
  errMsg?: string;
  errorMessage?: string;
  msg?: string;
}

declare global {
  interface Window {
    h5sdk?: {
      config: (opts: Record<string, unknown>) => void;
      ready: (cb: () => void) => void;
      error: (cb: (err: unknown) => void) => void;
    };
    tt?: {
      requestAccess?: (opts: Record<string, unknown>) => void;
      requestAuthCode?: (opts: Record<string, unknown>) => void;
      chooseChat?: (opts: Record<string, unknown>) => void;
      getBlockActionSourceDetail?: (opts: Record<string, unknown>) => void;
      getTriggerContext?: (opts: Record<string, unknown>) => void;
    };
  }
}

export function CompanionPage() {
  return <SendCard />;
}

function SendCard() {
  const [config, setConfig] = useState<PageConfig | null>(null);
  const [card, setCard] = useState<CardInfo | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState<'bot' | 'user' | null>(null);
  const [userAuth, setUserAuth] = useState<UserAuth | null>(null);
  const [inFeishu, setInFeishu] = useState(false);
  const [outsideFeishu, setOutsideFeishu] = useState(() => !inFeishuClient());
  const [apps, setApps] = useState<ListedApp[] | null>(null);
  const [chatId, setChatId] = useState('');
  const [sendingHref, setSendingHref] = useState('');
  const [sendingChatHref, setSendingChatHref] = useState('');
  const [introHref, setIntroHref] = useState(() => new URLSearchParams(window.location.search).get('app') || '');
  const fromPlus = isPlusMenu(new URLSearchParams(window.location.search));

  useEffect(() => {
    const onPop = () => setIntroHref(new URLSearchParams(window.location.search).get('app') || '');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (!fromPlus && !(inFeishu && apps !== null && !card)) return;
    const current = apps?.find((item) => item.href === introHref);
    document.title = current?.title || registeredDetail(introHref)?.title || '玛卡巴卡';
  }, [fromPlus, inFeishu, card, introHref, apps]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await getJson<PageConfig & { ok: boolean; error?: string }>('/api/config');
        if (!cfg.ok) throw new Error(cfg.error || '配置读取失败');
        if (cancelled) return;
        setConfig(cfg);
        await loadH5Sdk();
        if (cancelled) return;
        // h5-js-sdk 在任意浏览器都会赋值 window.tt / window.h5sdk，必须同时看 UA。
        const inside = inFeishuClient() && Boolean(window.h5sdk && window.tt);
        setInFeishu(inside);
        setOutsideFeishu(!inside);
        const params = new URLSearchParams(window.location.search);
        if (!inside) {
          setOutsideFeishu(true);
          if (cfg.previewUrl || cfg.localPreview || isPlusMenu(params) || params.get('app')) {
            const listed = await loadApps();
            if (!cancelled) setApps(listed);
          }
          return;
        }
        if (isPlusMenu(params)) {
          const listed = await loadApps();
          if (cancelled) return;
          setApps(listed);
          // UA 像飞书但实际在普通浏览器时，鉴权会失败：降级成外部环境，别整页报错。
          const jsapiOk = await configJsapi().then(
            () => true,
            () => false,
          );
          if (cancelled) return;
          if (!jsapiOk) {
            setInFeishu(false);
            setOutsideFeishu(true);
            return;
          }
          const triggerCode = readTriggerCode(params);
          if (!triggerCode) throw new Error('未拿到会话触发参数，请从聊天框的加号菜单进入。');
          const currentChat = await currentChatId(triggerCode);
          if (!cancelled) setChatId(currentChat);
          return;
        }
        if (!readTriggerCode(params) && !(params.get('message_id') || '').trim()) {
          const listed = await loadApps();
          if (cancelled) return;
          setApps(listed);
          // 鉴权失败说明并不真的在飞书里；应用列表已经拿到，降级即可。
          const jsapiOk = await configJsapi().then(
            () => true,
            () => false,
          );
          if (cancelled) return;
          if (!jsapiOk) {
            setInFeishu(false);
            setOutsideFeishu(true);
          }
          return;
        }
        const directId = (params.get('message_id') || '').trim();
        if (directId && cfg.allowDirectMessageId) {
          const info = await loadCard(directId);
          if (!cancelled) setCard(info);
          return;
        }
        const triggerCode = readTriggerCode(params);
        if (!triggerCode) throw new Error('未拿到消息触发参数，请从消息的快捷应用进入。');
        await configJsapi();
        const messageId = await sourceMessageId(triggerCode);
        const info = await loadCard(messageId);
        if (!cancelled) setCard(info);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function openIntro(app: ListedApp) {
    const params = new URLSearchParams(window.location.search);
    params.set('app', app.href);
    window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
    setIntroHref(app.href);
  }

  function closeIntro() {
    if (!introHref) return;
    const params = new URLSearchParams(window.location.search);
    params.delete('app');
    const search = params.toString();
    window.history.pushState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
    setIntroHref('');
  }

  function openAbout() {
    const about = apps?.find((item) => item.href === '/about');
    if (!about || introHref === about.href) return;
    openIntro(about);
  }

  async function sendApp(app: ListedApp) {
    if (sendingHref) return;
    if (!simulate && !chatId) {
      Toast.error('请从飞书聊天框的加号菜单打开后再发送');
      return;
    }
    setSendingHref(app.href);
    try {
      const result = simulate
        ? await getJson<{ ok: boolean; error?: string }>('/api/preview/deliver', { href: app.href, kind: 'chat' })
        : await getJson<{ ok: boolean; error?: string }>('/api/apps/send', { href: app.href, chatId });
      if (!result.ok) throw new Error(result.error || '发送失败');
      Toast.success(simulate ? `已把「${app.title}」发到模拟群` : `已把「${app.title}」发到当前会话`);
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingHref('');
    }
  }

  async function sendAppToChat(app: ListedApp) {
    if (sendingChatHref) return;
    if (!inFeishu || !window.tt?.chooseChat) {
      Toast.error('请在飞书客户端内选择会话');
      return;
    }
    setSendingChatHref(app.href);
    try {
      const chat = await chooseChat('发送');
      if (!chat) return;
      const result = await getJson<{ ok: boolean; error?: string }>('/api/apps/send', {
        href: app.href,
        chatId: chat.chatId,
      });
      if (!result.ok) throw new Error(result.error || '发送失败');
      Toast.success(`已把「${app.title}」发到「${chat.name || '会话'}」`);
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingChatHref('');
    }
  }

  function chooseTargetChat(): Promise<{ chatId: string; name: string } | null> {
    if (!inFeishu || !window.tt?.chooseChat) {
      return Promise.reject(new Error('请在飞书客户端内选择会话'));
    }
    return chooseChat('发送');
  }

  async function send(as: 'bot' | 'user') {
    if (!card || sending) return;
    if (!window.tt?.chooseChat) {
      Toast.error('请在飞书客户端内选择会话');
      return;
    }
    setSending(as);
    try {
      if (as === 'user') {
        const token = await ensureUserToken(config?.appId ?? '', userAuth, setUserAuth);
        const chat = await chooseChat(as === 'user' ? '以我的身份发送' : '以机器人身份发送');
        if (!chat) return;
        await postSend(card.messageId, chat, 'user', token);
      } else {
        const chat = await chooseChat('以机器人身份发送');
        if (!chat) return;
        await postSend(card.messageId, chat, 'bot');
      }
      Toast.success('已发送');
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(null);
    }
  }

  const simulate = Boolean((config?.previewUrl || config?.localPreview) && outsideFeishu);
  const showCatalog = fromPlus || simulate || (inFeishu && apps !== null && !card);
  const registered = introHref ? registeredDetail(introHref) : undefined;
  const currentApp =
    apps?.find((item) => item.href === introHref) ??
    (registered
      ? { href: introHref, title: registered.title, description: registered.description || '' }
      : undefined);
  const listedApps = apps?.filter((item) => item.href !== '/about' && item.href !== '/share') ?? null;

  if (loading && !config) {
    return (
      <main style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </main>
    );
  }

  if (outsideFeishu && !fromPlus && !introHref && !simulate) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <Banner
          type="warning"
          closeIcon={null}
          title="请在飞书中打开"
          description="在聊天输入框点「+」，从菜单进入。"
        />
      </main>
    );
  }

  if (showCatalog) {
    return (
      <div className="app-shell">
        <style>{APP_PICK_STYLE}</style>
        <Nav
          mode="horizontal"
          header={{
            logo: <img className="app-logo" src="/makabaka-logo.png" alt="" onClick={closeIntro} />,
            text: <span onClick={closeIntro}>玛卡巴卡</span>,
          }}
          items={[{ itemKey: 'about', text: '关于' }]}
          selectedKeys={introHref === '/about' ? ['about'] : []}
          onSelect={openAbout}
          footer={null}
        />
        <div className="app-shell-body">
          <Breadcrumb>
            <Breadcrumb.Item onClick={closeIntro}>应用</Breadcrumb.Item>
            {currentApp ? <Breadcrumb.Item>{currentApp.href === '/about' ? '关于' : currentApp.title}</Breadcrumb.Item> : null}
          </Breadcrumb>
          {simulate ? (
            <Banner
              type="info"
              closeIcon={null}
              description="当前是本地模拟群，不会发到飞书。在这里发布需求，别人在下面的卡片里留言。"
            />
          ) : outsideFeishu ? (
            <Banner
              type="warning"
              closeIcon={null}
              description="当前不在飞书里，可以预览表单。发送需要从聊天框的加号菜单进入。"
            />
          ) : null}
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
              <Spin size="large" />
            </div>
          ) : null}
          {error ? <Banner type="danger" description={error} closeIcon={null} /> : null}
          {currentApp && registered ? (
            <>
              {registered.render({
                app: currentApp,
                chatId,
                appId: config?.appId ?? '',
                inFeishu,
                preview: simulate,
                chooseTargetChat,
              })}
            </>
          ) : null}
          {currentApp && !registered ? (
            <AppIntro
              app={currentApp}
              sending={sendingHref === currentApp.href || sendingChatHref === currentApp.href}
              onCurrent={() => void sendApp(currentApp)}
              onPicked={() => void sendAppToChat(currentApp)}
            />
          ) : null}
          {listedApps && !currentApp ? (
            <div className="app-pick">
              {listedApps.map((app) => (
            <div
              key={app.href}
              className="app-pick-card"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('.app-pick-send')) return;
                openIntro(app);
              }}
            >
              <span className="app-pick-text">
                <span className="app-pick-title">{app.title}</span>
                {app.description ? <span className="app-pick-desc">{app.description}</span> : null}
              </span>
              <Button
                className="app-pick-send"
                theme="outline"
                type="primary"
                size="small"
                icon={<SendIcon />}
                loading={sendingHref === app.href}
                disabled={
                  registeredDetail(app.href)
                    ? false
                    : (!simulate && !chatId) || (sendingHref !== '' && sendingHref !== app.href)
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (registeredDetail(app.href)) {
                    openIntro(app);
                    return;
                  }
                  void sendApp(app);
                }}
              >
                {registeredDetail(app.href) ? '发布' : '发送'}
              </Button>
            </div>
          ))}
              {listedApps.length === 0 ? <Empty description="还没有可发送的应用" /> : null}
            </div>
          ) : null}
        </div>
        {simulate && config?.previewUrl ? (
          <iframe className="dev-room" title="模拟群聊" src={`${config.previewUrl}/?embed=1&room=dev`} />
        ) : null}
      </div>
    );
  }

  return (
    <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
      <Typography.Title heading={4} style={{ marginTop: 0 }}>
        {config?.title || '发送卡片'}
      </Typography.Title>
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : null}
      {error ? <Banner type="danger" description={error} closeIcon={null} /> : null}
      {card ? (
        <Card title={card.title || '卡片消息'} style={{ marginTop: error ? 16 : 0 }}>
          <Typography.Paragraph type="tertiary" style={{ marginTop: 0 }}>
            把这张卡片发到机器人所在的会话。以机器人身份发送时，机器人需要已经在目标会话里。
          </Typography.Paragraph>
          <Typography.Text type="tertiary" copyable={{ content: card.messageId }}>
            {card.messageId}
          </Typography.Text>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Button theme="solid" type="primary" loading={sending === 'user'} disabled={sending !== null || !inFeishu} onClick={() => void send('user')}>
              以我的身份发送
            </Button>
            <Button loading={sending === 'bot'} disabled={sending !== null || !inFeishu} onClick={() => void send('bot')}>
              以机器人身份发送
            </Button>
          </div>
          {inFeishu ? null : (
            <Typography.Paragraph type="tertiary" style={{ marginBottom: 0 }}>
              选择会话需要在飞书客户端内完成。
            </Typography.Paragraph>
          )}
        </Card>
      ) : null}
      {!loading && !error && !card && !apps ? <Empty description="没有可发送的卡片" /> : null}
    </main>
  );
}

async function postSend(messageId: string, chat: ChatPick, as: 'bot' | 'user', userAccessToken?: string) {
  const result = await getJson<{ ok: boolean; error?: string }>('/api/card/send', {
    messageId,
    chatId: chat.chatId,
    as,
    userAccessToken,
  });
  if (!result.ok) throw new Error(result.error || '发送失败');
}

async function loadCard(messageId: string): Promise<CardInfo> {
  const result = await getJson<{ ok: boolean; error?: string; messageId?: string; title?: string }>('/api/card', {
    messageId,
  });
  if (!result.ok || !result.messageId) throw new Error(result.error || '读取卡片失败');
  return { messageId: result.messageId, title: result.title || '' };
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="m9.47 13.12-4.11-2.74 13.1-4.92-5.22 13.05-2.38-3.97.09-.08 3.5-3.5a1 1 0 0 0-1.42-1.42l-3.5 3.5a1 1 0 0 0-.06.08ZM2.83 9.19l17.05-6.4a1 1 0 0 1 1.28 1.31l-6.81 17.03a1 1 0 0 1-1.79.14L9 15.32a1 1 0 0 0-.3-.32l-6.07-4.04a1 1 0 0 1 .2-1.77Z"
      />
    </svg>
  );
}

function AppIntro({
  app,
  sending,
  onCurrent,
  onPicked,
}: {
  app?: ListedApp;
  sending?: boolean;
  onCurrent?: () => void;
  onPicked?: () => void;
}) {
  const paragraphs = (app?.intro || app?.description || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return (
    <article className="app-intro">
      <h1>{app?.title || '没有这个应用'}</h1>
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {app && onCurrent && onPicked ? (
        <SendDropdown loading={sending} onCurrent={onCurrent} onPicked={onPicked} />
      ) : null}
    </article>
  );
}

export function SendDropdown({
  loading,
  disabled,
  onCurrent,
  onPicked,
}: {
  loading?: boolean;
  disabled?: boolean;
  onCurrent: () => void;
  onPicked: () => void;
}) {
  return (
    <Dropdown
      trigger="hover"
      position="topLeft"
      render={
        <Dropdown.Menu>
          <Dropdown.Item disabled={disabled || loading} onClick={onCurrent}>
            本会话
          </Dropdown.Item>
          <Dropdown.Item disabled={disabled || loading} onClick={onPicked}>
            指定会话
          </Dropdown.Item>
        </Dropdown.Menu>
      }
    >
      <span className="app-send-menu">
        <Button theme="outline" type="tertiary" icon={<SendIcon />} loading={loading} disabled={disabled}>
          发送
        </Button>
      </span>
    </Dropdown>
  );
}

const APP_PICK_STYLE = `
.app-shell .semi-navigation-horizontal {
  border-bottom: 1px solid var(--semi-color-border);
}
.app-logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  object-fit: cover;
  display: block;
  cursor: pointer;
}
.app-shell .semi-navigation-header-text {
  cursor: pointer;
}
.app-shell-body {
  max-width: 480px;
  margin: 0 auto;
  padding: 16px 12px 24px;
}
.app-shell-body .semi-breadcrumb {
  margin-bottom: 16px;
}
.dev-room {
  display: block;
  width: 100%;
  height: 720px;
  border: 0;
  border-top: 1px solid var(--semi-color-border);
  background: #f5f6f7;
}
.app-pick {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.app-pick-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 12px 14px;
  text-align: left;
  color: inherit;
  font: inherit;
  background: #fff;
  border: 1px solid #d9d9d9;
  border-radius: 8px;
  box-shadow: none;
  cursor: pointer;
  transition: box-shadow 0.15s ease;
}
.app-pick-card:hover {
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.12);
}
.app-pick-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  min-width: 0;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.app-pick-title {
  font-weight: 600;
}
.app-pick-desc {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
  font-weight: 400;
  white-space: normal;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.app-pick-send {
  align-self: flex-start;
}
.app-pick-send.semi-button-outline:not(.semi-button-disabled) {
  color: var(--semi-color-primary);
  border-color: var(--semi-color-primary);
  background: transparent;
  font-weight: 400;
}
.app-pick-send.semi-button-outline:not(.semi-button-disabled):hover {
  background: var(--semi-color-primary-light-default);
}
.app-intro h1 {
  margin: 0 0 12px;
  font-size: 20px;
  line-height: 1.4;
}
.app-send-menu {
  display: inline-flex;
  margin-top: 8px;
}
.app-intro p {
  margin: 0 0 12px;
  color: rgba(0, 0, 0, 0.75);
  line-height: 1.6;
  white-space: normal;
  word-break: break-word;
}
`;

function isPlusMenu(params: URLSearchParams): boolean {
  const from = params.get('from') || '';
  if (from === 'plus_menu_p2p' || from === 'plus_menu_group') return true;
  const ability = params.get('required_launch_ability') || launchQuery(params).required_launch_ability || '';
  return ability === 'chat_action';
}

function launchQuery(params: URLSearchParams): { __trigger_id__?: string; required_launch_ability?: string } {
  const raw = params.get('bdp_launch_query');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { __trigger_id__?: string; required_launch_ability?: string };
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function loadApps(): Promise<ListedApp[]> {
  const result = await getJson<{ ok: boolean; error?: string; apps?: ListedApp[] }>('/api/apps');
  if (!result.ok) throw new Error(result.error || '读取应用列表失败');
  return Array.isArray(result.apps) ? result.apps : [];
}

function currentChatId(triggerCode: string): Promise<string> {
  const tt = window.tt;
  if (!tt?.getTriggerContext) return Promise.reject(new Error('当前环境不能读取会话'));
  return new Promise((resolve, reject) => {
    tt.getTriggerContext?.({
      triggerCode,
      success: (res: { openChatId?: string }) => {
        if (!res?.openChatId) {
          reject(new Error('未取到当前会话'));
          return;
        }
        resolve(res.openChatId);
      },
      fail: (err: unknown) => reject(new Error(`获取会话失败：${formatAccessError(err)}`)),
    });
  });
}

function readTriggerCode(params: URLSearchParams): string {
  return launchQuery(params).__trigger_id__ || '';
}

function inFeishuClient(): boolean {
  return /Lark|Feishu/i.test(navigator.userAgent);
}

function loadH5Sdk(): Promise<void> {
  // 不在飞书里就完全不加载：这段脚本会无条件往 window 上挂 tt / h5sdk，会让环境判定失真。
  if (!inFeishuClient()) return Promise.resolve();
  if (window.h5sdk && window.tt) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = H5_SDK;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('飞书 JSSDK 加载失败'));
    document.head.appendChild(script);
  });
}

let jsapiReady: Promise<void> | null = null;

function configJsapi(): Promise<void> {
  if (jsapiReady) return jsapiReady;
  const pageUrl = window.location.origin + window.location.pathname + window.location.search;
  jsapiReady = getJson<{ ok: boolean; error?: string; appId?: string; timestamp?: number; nonceStr?: string; signature?: string }>(
    '/api/jsapi-signature',
    { url: pageUrl },
  ).then((cfg) => {
    if (!cfg.ok || !cfg.appId || !cfg.signature || cfg.timestamp == null || !cfg.nonceStr) {
      jsapiReady = null;
      throw new Error(cfg.error || '鉴权参数获取失败');
    }
    const h5sdk = window.h5sdk;
    if (!h5sdk) throw new Error('未检测到飞书 JSSDK');
    return new Promise<void>((resolve, reject) => {
      h5sdk.error((err) => reject(new Error(`h5sdk 鉴权失败：${formatAccessError(err)}`)));
      h5sdk.config({
        appId: cfg.appId,
        timestamp: cfg.timestamp,
        nonceStr: cfg.nonceStr,
        signature: cfg.signature,
        jsApiList: ['getBlockActionSourceDetail', 'getTriggerContext', 'requestAccess', 'requestAuthCode', 'chooseChat'],
        onSuccess: () => h5sdk.ready(() => resolve()),
        onFail: (err: unknown) => {
          jsapiReady = null;
          reject(new Error(`config 失败：${formatAccessError(err)}`));
        },
      });
    });
  });
  return jsapiReady;
}

function sourceMessageId(triggerCode: string): Promise<string> {
  const tt = window.tt;
  if (!tt?.getBlockActionSourceDetail) return Promise.reject(new Error('当前环境不能读取来源消息'));
  return new Promise((resolve, reject) => {
    tt.getBlockActionSourceDetail?.({
      triggerCode,
      success: (res: { content?: { messages?: Array<{ messageType?: string; openMessageId?: string }> } }) => {
        const msg = res?.content?.messages?.[0];
        if (!msg) {
          reject(new Error('未取到来源消息'));
          return;
        }
        if (msg.messageType !== 'interactive') {
          reject(new Error(`该消息不是卡片（${msg.messageType || '未知类型'}）`));
          return;
        }
        if (!msg.openMessageId) {
          reject(new Error('来源消息缺少 openMessageId'));
          return;
        }
        resolve(msg.openMessageId);
      },
      fail: (err: unknown) => reject(new Error(`获取消息失败：${formatAccessError(err)}`)),
    });
  });
}

function ensureUserToken(appId: string, current: UserAuth | null, save: (auth: UserAuth) => void): Promise<string> {
  if (current && current.accessToken && Date.now() < current.expiresAt - 60_000) {
    return Promise.resolve(current.accessToken);
  }
  return new Promise((resolve, reject) => {
    const tt = window.tt;
    const req = tt?.requestAccess || tt?.requestAuthCode;
    if (!req) {
      reject(new Error('请在飞书客户端内授权'));
      return;
    }
    if (!appId) {
      reject(new Error('缺少应用 appId'));
      return;
    }
    req.call(tt, {
      appID: appId,
      appId,
      scopeList: SEND_SCOPES.slice(),
      success: (res: { code?: string; authCode?: string }) => {
        const code = res?.code || res?.authCode;
        if (!code) {
          reject(new Error('未返回授权码'));
          return;
        }
        void getJson<{ ok: boolean; error?: string; accessToken?: string; expiresIn?: number }>('/api/auth/callback', { code })
          .then((user) => {
            if (!user.ok || !user.accessToken) {
              reject(new Error(user.error || '换取用户凭证失败'));
              return;
            }
            const expiresIn = user.expiresIn && user.expiresIn > 0 ? user.expiresIn : 7200;
            save({ accessToken: user.accessToken, expiresAt: Date.now() + expiresIn * 1000 });
            resolve(user.accessToken);
          })
          .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
      },
      fail: (err: unknown) => reject(new Error(formatAccessError(err))),
    });
  });
}

function chooseChat(confirmText: string): Promise<ChatPick | null> {
  const tt = window.tt;
  if (!tt?.chooseChat) return Promise.reject(new Error('请在飞书客户端内选择会话'));
  return configJsapi().then(
    () =>
      new Promise((resolve, reject) => {
        tt.chooseChat?.({
          multiSelect: false,
          allowCreateGroup: false,
          selectType: 0,
          externalChat: true,
          confirmTitle: '发送卡片',
          confirmText,
          success: (res: { data?: Array<{ id?: string; name?: string; i18nNames?: { zh_cn?: string } }> }) => {
            const chat = res?.data?.[0];
            if (!chat?.id) {
              resolve(null);
              return;
            }
            resolve({ chatId: chat.id, name: chat.name || chat.i18nNames?.zh_cn || '' });
          },
          fail: (err: unknown) => {
            const detail = err as JsapiError;
            const errno = detail?.errno ?? detail?.errCode;
            const text = detail?.errMsg || detail?.errString || '';
            if (errno === 10 || /cancel/i.test(text)) {
              resolve(null);
              return;
            }
            reject(new Error(`选择会话失败：${formatAccessError(err)}`));
          },
        });
      }),
  );
}

function formatAccessError(err: unknown): string {
  if (!err) return '授权失败';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  const detail = err as JsapiError;
  const errno = detail.errno ?? detail.errCode;
  const text = detail.errString || detail.errMsg || detail.errorMessage || detail.msg || '';
  if (text) return text.replace(/^requestAccess\s*fail[:\s]*/i, '') || '授权失败';
  if (errno != null) return `授权失败（errno ${errno}）`;
  return '授权失败';
}

async function getJson<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  return response.json() as Promise<T>;
}
