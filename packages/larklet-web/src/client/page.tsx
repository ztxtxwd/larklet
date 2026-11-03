import { Banner, Breadcrumb, Button, Card, Dropdown, Empty, Nav, Spin, Toast, Typography } from '@douyinfe/semi-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { chatInfoAttempts, plusChatType, readTriggerCode, sceneOf, type PlusChatType } from './launch.js';

const H5_SDK = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.40.js';
/**
 * 网页应用免登申请的权限。
 *
 * 读消息只要 `im:message`；以用户身份发消息还要 `im:message.send_as_user`。
 * 申请了应用没开通的用户身份权限，飞书会直接报错（20027），授权整个中断，
 * 所以读消息那条路不去申请发消息的权限。
 */
const USER_READ_SCOPES = ['im:message'];
const USER_SEND_SCOPES = ['im:message', 'im:message.send_as_user'];

/** 飞书消息类型。快捷操作对所有类型都开放，这里只把类型翻成人话。 */
const MESSAGE_TYPES: Record<string, string> = {
  text: '文本消息',
  image: '图片消息',
  post: '富文本消息',
  media: '视频消息',
  file: '文件消息',
  audio: '音频消息',
  sticker: '表情消息',
  interactive: '卡片消息',
  merge_forward: '合并转发消息',
  system: '系统消息',
  unsupport: '暂不支持的消息类型',
};

interface PageConfig {
  appId: string;
  allowDirectMessageId: boolean;
  title: string;
  /** 免登时申请的权限。 */
  scopes: string[];
  sendScopes: string[];
  previewUrl?: string;
  localPreview?: boolean;
}

interface MessageInfo {
  messageId: string;
  messageType: string;
}

/** 读消息的结果。读不到不算异常，错误文案给页面显示。 */
interface MessageRead {
  ok: boolean;
  msgType: string;
  error: string;
}

interface UserAuth {
  accessToken: string;
  expiresAt: number;
  /** 这个 token 授权时申请的权限。空的表示只要了用户身份。 */
  scopes?: string[];
  /** 授权时顺带取到的当前用户。 */
  openId?: string;
  name?: string;
  avatarUrl?: string;
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

/** 以谁的身份发送：用户本人，或机器人。 */
export type SendAs = 'user' | 'bot';
/** 发到哪里：当前打开本页的会话，或让用户再选一个。 */
export type SendTarget = 'current' | 'picked';

export interface AppDetailContext {
  app: ListedApp;
  chatId: string;
  appId: string;
  inFeishu: boolean;
  /** 浏览器直接打开、并且配置了 Larklet 预览地址。发送走模拟群，不打飞书。 */
  preview: boolean;
  /** 弹出飞书选会话。用户取消时返回 null。 */
  chooseTargetChat: (confirmText?: string) => Promise<{ chatId: string; name: string } | null>;
  /** 以当前用户身份发送需要的 user_access_token。必要时会弹出授权。 */
  requestUserToken: () => Promise<string>;
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

/** 当前用户。飞书里登录的那个人。 */
export interface PlusMenuUser {
  openId?: string;
  name?: string;
  avatarUrl?: string;
}

/** 加号菜单页面能拿到的东西。 */
export interface PlusMenuContext {
  /** 当前会话 ID，`oc_` 开头。 */
  chatId: string;
  /** 当前会话名称。客户端读不到时没有。 */
  chatName?: string;
  /** 当前用户。 */
  user: PlusMenuUser;
  /** 应用 appId。 */
  appId: string;
  /** 是否在飞书客户端内。 */
  inFeishu: boolean;
  /** 本地模拟群，不打飞书。 */
  preview: boolean;
  /** 机器人的应用目录（`app/catalog.ts`）。 */
  apps: ListedApp[];
  /** 正在发送的应用路径，空串表示没有。 */
  sendingHref: string;
  /** 打开某个应用。 */
  openApp: (app: ListedApp) => void;
  /** 把某个应用的卡片发出去。 */
  sendApp: (app: ListedApp, as: SendAs, target: SendTarget) => void;
  /** 弹出飞书选会话。用户取消时返回 null。 */
  chooseTargetChat: (confirmText?: string) => Promise<{ chatId: string; name: string } | null>;
  /** 以当前用户身份发送需要的 user_access_token。必要时会弹出授权。 */
  requestUserToken: () => Promise<string>;
}

export interface PlusMenuRegistration {
  /** 这一块内容的标题。 */
  title?: string;
  render: (ctx: PlusMenuContext) => ReactNode;
}

let plusMenu: PlusMenuRegistration | undefined;

/**
 * 加号菜单里放自己的内容。
 *
 * 没注册时，页面只显示当前会话与当前用户。注册的内容渲染在信息卡下面。
 */
export function registerPlusMenu(detail: PlusMenuRegistration): void {
  plusMenu = detail;
}

function registeredPlusMenu(): PlusMenuRegistration | undefined {
  return plusMenu;
}

/**
 * 现成的应用目录：列出机器人的应用，点了把卡片发到当前会话。
 *
 * ```tsx
 * registerPlusMenu(appCatalogMenu());
 * ```
 */
export function appCatalogMenu(): PlusMenuRegistration {
  return {
    title: '应用',
    render: (ctx) => (
      <AppList
        apps={ctx.apps}
        sendingHref={ctx.sendingHref}
        inFeishu={ctx.inFeishu}
        preview={ctx.preview}
        chatId={ctx.chatId}
        onOpen={ctx.openApp}
        onSend={ctx.sendApp}
      />
    ),
  };
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
      getChatInfo?: (opts: Record<string, unknown>) => void;
    };
  }
}

export function CompanionPage() {
  return <SendCard />;
}

function SendCard() {
  const [config, setConfig] = useState<PageConfig | null>(null);
  const [messageId, setMessageId] = useState('');
  const [messageType, setMessageType] = useState('');
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState('');
  /** 机器人读不到这条消息，要用户授权才能读。 */
  const [needUserAuth, setNeedUserAuth] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [userAuth, setUserAuth] = useState<UserAuth | null>(null);
  const [userError, setUserError] = useState('');
  // 授权结果留在 ref 里：换掉 token 时不必再弹一次授权。
  const authRef = useRef<UserAuth | null>(null);
  const [inFeishu, setInFeishu] = useState(false);
  const [outsideFeishu, setOutsideFeishu] = useState(() => !inFeishuClient());
  const [apps, setApps] = useState<ListedApp[] | null>(null);
  const [chatId, setChatId] = useState('');
  const [chatName, setChatName] = useState('');
  const [sendingHref, setSendingHref] = useState('');
  const [introHref, setIntroHref] = useState(() => new URLSearchParams(window.location.search).get('app') || '');
  const scene = sceneOf(new URLSearchParams(window.location.search), window.location.pathname);
  const fromPlus = scene === 'plus';
  const fromMessage = scene === 'message';

  useEffect(() => {
    const onPop = () => setIntroHref(new URLSearchParams(window.location.search).get('app') || '');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (fromPlus) {
      document.title = config?.title || '飞书应用';
      return;
    }
    if (fromMessage) {
      document.title = config?.title || '消息快捷操作';
      return;
    }
    if (!(inFeishu && apps !== null && !messageId)) return;
    const current = apps?.find((item) => item.href === introHref);
    document.title = current?.title || registeredDetail(introHref)?.title || '玛卡巴卡';
  }, [fromPlus, fromMessage, inFeishu, messageId, introHref, apps, config]);

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
          // 开发时可以直接用 ?message_id= 看一条消息。
          const devId = (params.get('message_id') || '').trim();
          if (devId && cfg.allowDirectMessageId) {
            if (!cancelled) setMessageId(devId);
            await readSourceMessage(devId, cfg.appId, cfg.scopes);
            return;
          }
          if (fromPlus) {
            // 应用目录是可选的，读不到也别把整页带崩。
            const listed = await loadApps().catch(() => [] as ListedApp[]);
            if (!cancelled) setApps(listed);
          } else if (cfg.previewUrl || cfg.localPreview || params.get('app')) {
            const listed = await loadApps();
            if (!cancelled) setApps(listed);
          }
          return;
        }
        if (fromPlus) {
          // 应用目录是可选的，读不到也别把整页带崩。
          const listed = await loadApps().catch(() => [] as ListedApp[]);
          if (!cancelled) setApps(listed);
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
          if (cancelled) return;
          setChatId(currentChat);
          // 会话名读不到就算了，chat ID 才是要紧的。
          const name = await chatNameOf(currentChat, plusChatType(params)).catch(() => '');
          if (!cancelled) setChatName(name);
          await loadUserInfo(cfg.appId);
          return;
        }
        if (!fromMessage && !readTriggerCode(params) && !(params.get('message_id') || '').trim()) {
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
          if (!cancelled) setMessageId(directId);
          await loadUserInfo(cfg.appId);
          await readSourceMessage(directId, cfg.appId, cfg.scopes);
          return;
        }
        const triggerCode = readTriggerCode(params);
        if (!triggerCode) throw new Error('未拿到消息触发参数，请从消息的快捷应用进入。');
        await configJsapi();
        // 任何消息类型都能打开快捷操作，不再只认卡片。
        const source = await sourceMessageId(triggerCode);
        if (!cancelled) setMessageId(source);
        // 当前用户：只要登录信息，不需要任何权限，也不会弹授权。
        await loadUserInfo(cfg.appId);
        await readSourceMessage(source, cfg.appId, cfg.scopes);
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

  function saveUserAuth(auth: UserAuth) {
    authRef.current = auth;
    setUserAuth(auth);
  }

  /**
   * 读这条消息的类型。
   *
   * 先让服务端用机器人身份读：机器人在这条消息的会话里的话，不用麻烦用户授权。
   * 机器人读不到（多半是机器人不在群里），才让用户授权，用用户身份再读一次。
   */
  async function readSourceMessage(id: string, appId: string, scopes: string[]) {
    setReading(true);
    setReadError('');
    setNeedUserAuth(false);
    // 用户已经授权过并且覆盖得住这次要的权限，就直接用，不用再问机器人。
    if (!coversScopes(authRef.current?.scopes, scopes)) {
      const asBot = await loadMessage(id, '').catch(() => null);
      if (asBot?.ok) {
        setMessageType(asBot.msgType ?? '');
        setReading(false);
        return;
      }
    }
    let auth: UserAuth;
    try {
      auth = await ensureUserToken(appId, authRef.current, saveUserAuth, scopes);
    } catch (err) {
      setUserError(err instanceof Error ? err.message : String(err));
      setNeedUserAuth(true);
      setReading(false);
      return;
    }
    try {
      const info = await loadMessage(id, auth.accessToken);
      if (info.ok) setMessageType(info.msgType);
      else setReadError(info.error);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
    }
  }

  async function sendApp(app: ListedApp, as: SendAs, target: SendTarget) {
    if (sendingHref) return;
    if (simulate) {
      if (as !== 'bot' || target !== 'current') return;
      setSendingHref(app.href);
      try {
        const result = await getJson<{ ok: boolean; error?: string }>('/api/preview/deliver', {
          href: app.href,
          kind: 'chat',
        });
        if (!result.ok) throw new Error(result.error || '发送失败');
        Toast.success(`已把「${app.title}」发到模拟群`);
      } catch (err) {
        Toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setSendingHref('');
      }
      return;
    }
    if (!inFeishu) {
      Toast.error('请从飞书聊天框的加号菜单打开后再发送');
      return;
    }
    setSendingHref(app.href);
    try {
      let targetChat = chatId;
      let targetName = '';
      if (target === 'picked') {
        const chat = await chooseChat(as === 'user' ? '以我的身份发送' : '以机器人身份发送');
        if (!chat) return;
        targetChat = chat.chatId;
        targetName = chat.name;
      }
      if (!targetChat) {
        Toast.error('请从飞书聊天框的加号菜单打开后再发送');
        return;
      }
      const userAccessToken =
        as === 'user'
          ? (
              await ensureUserToken(
                config?.appId ?? '',
                authRef.current,
                saveUserAuth,
                config?.sendScopes ?? USER_SEND_SCOPES,
              )
            ).accessToken
          : undefined;
      const result = await getJson<{ ok: boolean; error?: string }>('/api/apps/send', {
        href: app.href,
        chatId: targetChat,
        as,
        ...(userAccessToken ? { userAccessToken } : {}),
      });
      if (!result.ok) throw new Error(result.error || '发送失败');
      const where = targetName ? `「${targetName}」` : '当前会话';
      Toast.success(`${as === 'user' ? '已以我的身份' : '已以机器人身份'}把「${app.title}」发到${where}`);
    } catch (err) {
      Toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingHref('');
    }
  }

  function chooseTargetChat(confirmText = '发送'): Promise<{ chatId: string; name: string } | null> {
    if (!inFeishu || !window.tt?.chooseChat) {
      return Promise.reject(new Error('请在飞书客户端内选择会话'));
    }
    return chooseChat(confirmText);
  }

  function requestUserToken(): Promise<string> {
    if (!inFeishu) return Promise.reject(new Error('请在飞书客户端内授权'));
    return ensureUserToken(config?.appId ?? '', authRef.current, saveUserAuth, config?.sendScopes ?? USER_SEND_SCOPES).then(
      (auth) => auth.accessToken,
    );
  }

  /**
   * 只要登录用户信息。传空 scope 列表，飞书不会让用户做增量授权，
   * 也不需要应用开通任何权限。
   */
  async function loadUserInfo(appId: string) {
    setUserError('');
    try {
      await ensureUserToken(appId, authRef.current, saveUserAuth, []);
    } catch (err) {
      setUserError(err instanceof Error ? err.message : String(err));
    }
  }

  /** 授权失败后由用户手动重试一次。 */
  async function authorizePlusUser() {
    await loadUserInfo(config?.appId ?? '');
  }

  /** 授权失败后由用户手动重试一次，授权过了再读一遍消息。 */
  async function authorizeAndRead() {
    setUserError('');
    try {
      await ensureUserToken(config?.appId ?? '', authRef.current, saveUserAuth, config?.scopes ?? USER_READ_SCOPES);
    } catch (err) {
      setUserError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (messageId) await readSourceMessage(messageId, config?.appId ?? '', config?.scopes ?? USER_READ_SCOPES);
  }

  const simulate = Boolean((config?.previewUrl || config?.localPreview) && outsideFeishu);
  // 有来源消息就显示消息页：快捷操作对所有消息类型都开放。
  // 加号菜单有自己的页面：当前会话与当前用户。
  const showCatalog = !messageId && !fromPlus && !fromMessage && (simulate || (inFeishu && apps !== null));
  const registered = introHref ? registeredDetail(introHref) : undefined;
  const currentApp =
    apps?.find((item) => item.href === introHref) ??
    (registered
      ? { href: introHref, title: registered.title, description: registered.description || '' }
      : undefined);
  const listedApps = apps?.filter((item) => item.href !== '/about' && item.href !== '/share') ?? null;
  const plusRegistration = registeredPlusMenu();
  const plusContext: PlusMenuContext = {
    chatId,
    ...(chatName ? { chatName } : {}),
    user: {
      ...(userAuth?.openId ? { openId: userAuth.openId } : {}),
      ...(userAuth?.name ? { name: userAuth.name } : {}),
      ...(userAuth?.avatarUrl ? { avatarUrl: userAuth.avatarUrl } : {}),
    },
    appId: config?.appId ?? '',
    inFeishu,
    preview: simulate,
    apps: listedApps ?? [],
    sendingHref,
    openApp: openIntro,
    sendApp: (app, as, target) => void sendApp(app, as, target),
    chooseTargetChat,
    requestUserToken,
  };

  /** 某个应用的详情：注册过的用自己的内容，没注册的就是介绍加「发送」。 */
  function appDetailView(app: ListedApp) {
    const detail = registeredDetail(app.href);
    if (detail) {
      return detail.render({
        app,
        chatId,
        appId: config?.appId ?? '',
        inFeishu,
        preview: simulate,
        chooseTargetChat,
        requestUserToken,
      });
    }
    return (
      <AppIntro
        app={app}
        sending={sendingHref === app.href}
        disabled={!simulate && !inFeishu}
        allowUser={!simulate && inFeishu}
        allowCurrent={simulate || Boolean(chatId)}
        allowPicked={!simulate && inFeishu}
        onSend={(as, target) => void sendApp(app, as, target)}
      />
    );
  }

  if (loading && !config) {
    return (
      <main style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
        <Spin size="large" />
      </main>
    );
  }

  if (outsideFeishu && !fromPlus && !introHref && !simulate && !messageId) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <Banner
          type="warning"
          closeIcon={null}
          title="请在飞书中打开"
          description={
            fromMessage
              ? '在消息的「…」菜单里选本应用进入。'
              : '在聊天输入框点「+」，从菜单进入。'
          }
        />
      </main>
    );
  }

  if (fromPlus) {
    return (
      <main style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <style>{APP_PICK_STYLE}</style>
        <Typography.Title heading={4} style={{ marginTop: 0 }}>
          {config?.title || '飞书应用'}
        </Typography.Title>
        {error ? <Banner type="danger" description={error} closeIcon={null} /> : null}
        {outsideFeishu ? (
          <Banner
            type="warning"
            closeIcon={null}
            description="当前不在飞书里，看不到真实会话。从聊天框的「+」菜单进入才有会话与用户信息。"
          />
        ) : null}
        <Card title="会话">
          <div className="info-row">
            <span className="info-label">当前会话</span>
            <span className="info-value">
              {chatId ? (
                <>
                  <span>{chatId}</span>
                  {chatName ? <span className="info-sub">{chatName}</span> : null}
                </>
              ) : (
                <span className="info-sub">{error ? '读取失败' : inFeishu ? '读取中…' : '未知'}</span>
              )}
            </span>
          </div>
          <div className="info-row">
            <span className="info-label">当前用户</span>
            <span className="info-value">
              {userAuth?.accessToken ? (
                userAuth.name || userAuth.openId ? (
                  <>
                    {userAuth.avatarUrl ? <img className="info-avatar" src={userAuth.avatarUrl} alt="" /> : null}
                    <span>{userAuth.name || '未命名用户'}</span>
                    {userAuth.openId ? <span className="info-sub">{userAuth.openId}</span> : null}
                  </>
                ) : (
                  <span>已授权</span>
                )
              ) : (
                <span className="info-sub">{userError || '未授权'}</span>
              )}
            </span>
          </div>
          {userAuth?.accessToken ? null : (
            <div className="info-actions">
              <Button theme="outline" type="primary" disabled={!inFeishu} onClick={() => void authorizePlusUser()}>
                授权后显示用户信息
              </Button>
              {inFeishu ? null : <span className="info-sub">授权需要在飞书客户端内完成。</span>}
            </div>
          )}
        </Card>
        {plusRegistration ? (
          <section className="plus-menu">
            {plusRegistration.title ? <Typography.Title heading={5}>{plusRegistration.title}</Typography.Title> : null}
            {plusRegistration.render(plusContext)}
          </section>
        ) : null}
        {currentApp ? appDetailView(currentApp) : null}
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
          {currentApp ? appDetailView(currentApp) : null}
          {listedApps && !currentApp ? (
            <AppList
              apps={listedApps}
              sendingHref={sendingHref}
              inFeishu={inFeishu}
              preview={simulate}
              chatId={chatId}
              onOpen={openIntro}
              onSend={(app, as, target) => void sendApp(app, as, target)}
            />
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
      <style>{APP_PICK_STYLE}</style>
      <Typography.Title heading={4} style={{ marginTop: 0 }}>
        {config?.title || '消息快捷操作'}
      </Typography.Title>
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 48 }}>
          <Spin size="large" />
        </div>
      ) : null}
      {error ? <Banner type="danger" description={error} closeIcon={null} /> : null}
      <Card title="消息" style={{ marginTop: error ? 16 : 0 }}>
        <div className="info-row">
          <span className="info-label">当前用户</span>
          <span className="info-value">
            {userAuth?.accessToken ? (
              userAuth.name || userAuth.openId ? (
                <>
                  {userAuth.avatarUrl ? <img className="info-avatar" src={userAuth.avatarUrl} alt="" /> : null}
                  <span>{userAuth.name || '未命名用户'}</span>
                  {userAuth.openId ? <span className="info-sub">{userAuth.openId}</span> : null}
                </>
              ) : (
                <span>已授权</span>
              )
            ) : (
              <span className="info-sub">{userError || '未授权'}</span>
            )}
          </span>
        </div>
        <div className="info-row">
          <span className="info-label">当前消息</span>
          <span className="info-value">
            {messageId ? (
              <span>{messageId}</span>
            ) : (
              <span className="info-sub">{reading ? '读取中…' : '—'}</span>
            )}
          </span>
        </div>
        <div className="info-row">
          <span className="info-label">消息类型</span>
          <span className="info-value">
            {messageType ? messageTypeLabel(messageType) : reading ? '读取中…' : '—'}
            {readError ? <span className="info-sub">{readError}</span> : null}
          </span>
        </div>
        {needUserAuth ? (
          <div className="info-actions">
            <Button theme="outline" type="primary" disabled={!inFeishu} onClick={() => void authorizeAndRead()}>
              授权后读取这条消息
            </Button>
            {inFeishu ? null : <span className="info-sub">授权需要在飞书客户端内完成。</span>}
          </div>
        ) : null}
      </Card>
      {!loading && !error && !messageId ? <Empty description="没有来源消息" /> : null}
    </main>
  );
}

/**
 * 读消息类型。
 *
 * `userAccessToken` 传空串就是让服务端用机器人身份读：机器人在会话里的话，
 * 不用用户授权就能读到。
 */
async function loadMessage(messageId: string, userAccessToken: string): Promise<MessageRead> {
  const result = await getJson<{ ok: boolean; error?: string; messageId?: string; msgType?: string }>('/api/message', {
    messageId,
    userAccessToken,
  });
  if (!result.ok) return { ok: false, msgType: '', error: result.error || '读取消息失败' };
  return { ok: true, msgType: result.msgType || '', error: '' };
}

function messageTypeLabel(messageType?: string): string {
  if (!messageType) return '未知消息类型';
  return MESSAGE_TYPES[messageType] || messageType;
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
  disabled,
  allowUser,
  allowCurrent,
  allowPicked,
  onSend,
}: {
  app?: ListedApp;
  sending?: boolean;
  disabled?: boolean;
  allowUser?: boolean;
  allowCurrent?: boolean;
  allowPicked?: boolean;
  onSend?: (as: SendAs, target: SendTarget) => void;
}) {
  const paragraphs = (app?.intro || app?.description || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  return (
    <article className="app-intro">
      <h1>{app?.title || '没有这个应用'}</h1>
      {paragraphs.map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {app && onSend ? (
        <SendMenu
          loading={sending}
          disabled={disabled}
          allowUser={allowUser}
          allowCurrent={allowCurrent}
          allowPicked={allowPicked}
          onSend={onSend}
        />
      ) : null}
    </article>
  );
}

interface AppListProps {
  apps: ListedApp[];
  sendingHref: string;
  inFeishu: boolean;
  /** 本地模拟群，不打飞书。 */
  preview: boolean;
  /** 当前会话。有它才能「发送到本会话」。 */
  chatId: string;
  onOpen: (app: ListedApp) => void;
  onSend: (app: ListedApp, as: SendAs, target: SendTarget) => void;
}

/** 机器人的应用列表。点一下把对应的卡片发到会话。 */
function AppList({ apps, sendingHref, inFeishu, preview, chatId, onOpen, onSend }: AppListProps) {
  if (apps.length === 0) return <Empty description="还没有可发送的应用" />;
  return (
    <div className="app-pick">
      {apps.map((app) => (
        <div
          key={app.href}
          className="app-pick-card"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('.app-pick-send')) return;
            onOpen(app);
          }}
        >
          <span className="app-pick-text">
            <span className="app-pick-title">{app.title}</span>
            {app.description ? <span className="app-pick-desc">{app.description}</span> : null}
          </span>
          {registeredDetail(app.href) ? (
            <Button
              className="app-pick-send"
              theme="outline"
              type="primary"
              size="small"
              icon={<SendIcon />}
              onClick={(event) => {
                event.stopPropagation();
                onOpen(app);
              }}
            >
              发布
            </Button>
          ) : (
            <SendMenu
              className="app-pick-send"
              size="small"
              type="primary"
              loading={sendingHref === app.href}
              disabled={(!preview && !inFeishu) || (sendingHref !== '' && sendingHref !== app.href)}
              allowUser={!preview && inFeishu}
              allowCurrent={preview || Boolean(chatId)}
              allowPicked={!preview && inFeishu}
              onSend={(as, target) => onSend(app, as, target)}
            />
          )}
        </div>
      ))}
    </div>
  );
}

export interface SendMenuProps {
  loading?: boolean;
  disabled?: boolean;
  /** 本地预览没有飞书身份，不能以用户身份发送。 */
  allowUser?: boolean;
  /** 不在从加号菜单打开的会话里时，没有「本会话」可发。 */
  allowCurrent?: boolean;
  /** 本地预览不能选其他会话。 */
  allowPicked?: boolean;
  size?: 'small' | 'default';
  type?: 'primary' | 'tertiary';
  className?: string;
  onSend: (as: SendAs, target: SendTarget) => void;
}

/** 每个应用的发送按钮：身份（用户 / 机器人）与会话（本会话 / 指定会话）各二选一。 */
export function SendMenu({
  loading,
  disabled,
  allowUser = true,
  allowCurrent = true,
  allowPicked = true,
  size = 'default',
  type = 'tertiary',
  className,
  onSend,
}: SendMenuProps) {
  const blocked = Boolean(disabled || loading);
  return (
    <Dropdown
      trigger="click"
      position="topLeft"
      render={
        <Dropdown.Menu>
          <Dropdown.Item disabled={blocked || !allowUser || !allowCurrent} onClick={() => onSend('user', 'current')}>
            以用户身份发送到本会话
          </Dropdown.Item>
          <Dropdown.Item disabled={blocked || !allowUser || !allowPicked} onClick={() => onSend('user', 'picked')}>
            以用户身份发送到指定会话
          </Dropdown.Item>
          <Dropdown.Divider />
          <Dropdown.Item disabled={blocked || !allowCurrent} onClick={() => onSend('bot', 'current')}>
            以机器人身份发送到本会话
          </Dropdown.Item>
          <Dropdown.Item disabled={blocked || !allowPicked} onClick={() => onSend('bot', 'picked')}>
            以机器人身份发送到指定会话
          </Dropdown.Item>
        </Dropdown.Menu>
      }
    >
      <span className="app-send-menu">
        <Button
          className={className}
          theme="outline"
          type={type}
          size={size}
          icon={<SendIcon />}
          loading={loading}
          disabled={disabled}
        >
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
.app-pick .app-send-menu {
  margin-top: 0;
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
.info-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px 0;
}
.info-row + .info-row {
  border-top: 1px solid var(--semi-color-border);
}
.info-label {
  flex: none;
  width: 72px;
  color: rgba(0, 0, 0, 0.45);
}
.info-value {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
  word-break: break-word;
}
.info-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}
.info-sub {
  color: rgba(0, 0, 0, 0.45);
  font-size: 12px;
}
.info-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
.plus-menu {
  margin-top: 16px;
}
.plus-menu .semi-typography {
  margin: 0 0 8px;
}
`;

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

/**
 * 当前会话的名称。读不到就抛错，调用方自己决定要不要显示。
 *
 * 单聊要带 userType，群聊不用。PC 能从 `from` 看出是哪种会话，
 * 移动端看不出来，就群聊、单聊各试一次。
 */
async function chatNameOf(openChatId: string, chatType: PlusChatType): Promise<string> {
  const tt = window.tt;
  if (!tt?.getChatInfo) throw new Error('当前环境不能读取会话信息');
  let lastError: unknown;
  for (const [type, user] of chatInfoAttempts(chatType)) {
    try {
      const info = await readChatInfo(openChatId, type, user);
      if (info.name) return info.name;
      lastError = new Error('没有读到会话名称');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('读取会话信息失败');
}

function readChatInfo(openChatId: string, chatType: 0 | 1, userType: 0 | 1): Promise<{ name: string }> {
  const tt = window.tt;
  const getChatInfo = tt?.getChatInfo;
  if (!getChatInfo) return Promise.reject(new Error('当前环境不能读取会话信息'));
  return new Promise((resolve, reject) => {
    getChatInfo.call(tt, {
      openChatId,
      chatType,
      userType,
      success: (res: { name?: string; i18nNames?: { zh_cn?: string } }) => {
        resolve({ name: res?.name || res?.i18nNames?.zh_cn || '' });
      },
      fail: (err: unknown) => reject(new Error(`获取会话信息失败：${formatAccessError(err)}`)),
    });
  });
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
        jsApiList: [
          'getBlockActionSourceDetail',
          'getTriggerContext',
          'getChatInfo',
          'requestAccess',
          'requestAuthCode',
          'chooseChat',
        ],
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

/** 来源消息。快捷操作对所有消息类型都开放，不只卡片。 */
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

/**
 * 网页应用免登：拿授权码换 user_access_token，顺带取回当前用户。
 * 授权过且没过期就复用缓存。
 *
 * `scopes` 是这次要的权限。缓存里的 token 没覆盖到，就重新授权一次：
 * 加号菜单只拿用户身份（空列表），读消息要 `im:message`，两者的 token 不能混用。
 */
function ensureUserToken(
  appId: string,
  current: UserAuth | null,
  save: (auth: UserAuth) => void,
  scopes: string[] = USER_READ_SCOPES,
): Promise<UserAuth> {
  if (
    current &&
    current.accessToken &&
    Date.now() < current.expiresAt - 60_000 &&
    coversScopes(current.scopes, scopes)
  ) {
    return Promise.resolve(current);
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
      scopeList: scopes.slice(),
      success: (res: { code?: string; authCode?: string }) => {
        const code = res?.code || res?.authCode;
        if (!code) {
          reject(new Error('未返回授权码'));
          return;
        }
        void getJson<{
          ok: boolean;
          error?: string;
          accessToken?: string;
          expiresIn?: number;
          openId?: string;
          name?: string;
          avatarUrl?: string;
        }>('/api/auth/callback', { code })
          .then((user) => {
            if (!user.ok || !user.accessToken) {
              reject(new Error(user.error || '换取用户凭证失败'));
              return;
            }
            const expiresIn = user.expiresIn && user.expiresIn > 0 ? user.expiresIn : 7200;
            const auth: UserAuth = {
              accessToken: user.accessToken,
              expiresAt: Date.now() + expiresIn * 1000,
              scopes: scopes.slice(),
              ...(user.openId ? { openId: user.openId } : {}),
              ...(user.name ? { name: user.name } : {}),
              ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
            };
            save(auth);
            resolve(auth);
          })
          .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
      },
      fail: (err: unknown) => reject(new Error(formatAccessError(err))),
    });
  });
}

/** 缓存的 token 能不能覆盖这次要的权限。 */
function coversScopes(have: string[] | undefined, want: string[]): boolean {
  if (!want.length) return true;
  const owned = new Set(have ?? []);
  return want.every((scope) => owned.has(scope));
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
