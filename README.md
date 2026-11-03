# Larklet

飞书交互卡片的服务端框架。一张卡片就是一个页面，点击就是一次 Server Action，webhook / 长连接只是传输层。

底层卡片 JSON、JSX 和卡片内状态沿用 npm 上的 `@open-feishu-card` 系列包：`components` 把 TSX 收成 Schema 2.0，`store` 把状态封印进卡片，`renderer` 在本地预览里渲染 DOM。Larklet 补上 Next.js App Router 那一层。

## 对照

| Next.js | Larklet |
| --- | --- |
| `app/page.tsx` | 一张卡片 |
| `app/ticket/[id]/page.tsx` | 带参数的卡片 |
| `layout.tsx` | 包住页面的 `<Card>` / 页眉 |
| Server Component | 默认。卡片没有客户端运行时 |
| `'use server'` | 按钮 / 表单的回调 |
| `redirect()` | 用另一张卡片替换当前消息上的卡片 |
| 路由端点 | 机器人菜单 `event_key`，或私聊/群聊 `@bot /路径` 打开同一条路径 |
| 路由别名 | 页面导出 `aliases`。`/指引` 与 `/guide` 打开同一张卡片 |
| `searchParams` | 写在 `redirect('/ticket/1?from=home')` 里 |
| `cookies()` / 会话 | `getCardState` / `setCardState`，随卡片往返，不占服务器会话 |
| `next dev` | `larklet dev`：本地预览里点按钮，走同一套回调 |

飞书回调不带回整张卡片，所以路由和 `cardState` 会压缩进每个交互组件的 `value.__larklet`，同时用 `@open-feishu-card/store` 封印一份，方便从 `raw_card_content` 回读。

## 应用

```tsx
// app/layout.tsx
import { Card, Header } from 'larklet/card';

export default function RootLayout({ children }) {
  return (
    <Card config={{ update_multi: true }}>
      <Header title="审批" />
      {children}
    </Card>
  );
}
```

```tsx
// app/page.tsx
import { Button, Markdown, bindAction } from 'larklet/card';
import { getCardState, redirect, setCardState } from 'larklet';

export default function Page() {
  const n = getCardState<{ n: number }>()?.n ?? 0;
  return (
    <>
      <Markdown content={`计数 ${n}`} />
      <Button action={inc}>加一</Button>
      <Button action={bindAction(openItem, '42')}>打开 42</Button>
    </>
  );
}

export async function inc() {
  'use server';
  const n = getCardState<{ n: number }>()?.n ?? 0;
  setCardState({ n: n + 1 });
}

export async function openItem(id: string) {
  'use server';
  redirect(`/item/${id}`);
}
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "larklet",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  }
}
```

页面和 Action 都是服务端函数。Action 必须是模块导出的具名函数，函数体第一行写 `'use server'`。`bindAction(fn, ...params)` 的参数会在回调时原样传回。表单字段用 `formValue()` 读，点击者用 `operator()`，消息 id 用 `messageContext()`。

群里要给某个人单独看一张卡片时，在 Server Action 里调用 `sendEphemeral(href, openId)`。它会按收件人重新渲染 `href`（这时 `operator().openId` 是收件人），再通过飞书「仅特定人可见」接口发到当前群。返回的 `messageId` 交给 `deleteEphemeral` 删掉。当前消息没有 `openChatId` 时，用 `{ chatId }` 指定群。本地预览不会打到飞书，会在会话旁多开一栏，标成「仅此人可见」。

已经拿到卡片 JSON、或不在 Action 里时，用 `sendEphemeralCard` / `deleteEphemeralCard`，自己传入 `accessToken`。卡片按对象提交，不要先 `JSON.stringify`。国际版把 `openApiBase` 设为 `https://open.larksuite.com`。

没有 `layout.tsx` 时，根节点要是 `<Card>`，或者由框架补一张默认卡片。

## 运行

```bash
pnpm install
pnpm test
pnpm inbox          # 示例，打开 http://127.0.0.1:8787（首页「开始指引」进入四步 /guide）
                    # 凭证：复制 examples/inbox/.env.example 为 .env，填写 APP_ID / APP_SECRET
```

预览页直接在卡片上点按钮、填表单。渲染器需要带 `interactive: true`，回调写在按钮的 `data-feishu-action` 上。

同一页可以打开多张卡片，每张有一名模拟用户（`open_id` / 用户名 / 头像）。再打开同一路径会加入已经打开的那次会话：只有一个人时按私聊带上他的消息 id，两个人及以上共享同一条消息。共享更新（`update_multi` 不为 `false`）会刷新这一会话里的每张卡片，并在跳转后一起换到新路径。只更新操作者本人时，其他人保持原卡片。`operator()` 读到的是点按钮的那一名模拟用户。

配套网页在开发时会嵌一个模拟群（`/?embed=1&room=dev`），用来和机器人联调。这个群不出现在单独打开的预览页上，刷新预览也不会留下网页里发出的卡片。群里固定有一名卖家和至少两名买家，嵌进去的页面可以点「加一位买家」。网页进程把卡片投进这个群，嵌页用 SSE 接住：

- `GET /_larklet/preview/room?id=dev` 读取 `chatId` 和虚拟用户
- `POST /_larklet/preview/deliver` 投递 `{ room, kind: "chat" | "ephemeral", href, userState, openId?, media? }`
- `GET /_larklet/preview/stream?room=dev` 推送群里的卡片
- `POST /_larklet/preview/room` `{ id, action: "add-user" }` 加一名买家

`kind: "chat"` 的卡片每个人都能看到，`ephemeral` 只出现在 `openId` 那一栏。这些接口只在 `larklet dev` 开放。群里的点击仍走 `/_larklet/event`，卖家私卡和共享卡片的更新会写回这个群。

单独打开预览、再打开某条路径时，如果页面导出了 `previewScene`，会按场景铺开一组虚拟用户，而不是那张「还没发布」的说明卡。场景只活在这一页，刷新就回到首页。

```tsx
export const previewScene = {
  userState: { preview: { description: '九成新台灯，可自提' } },
  users: [
    { name: '阿明', role: 'seller' },
    { name: '小林', role: 'buyer' },
  ],
  aside: { href: '/idle/quotes', role: 'seller', userState: { preview: { description: '九成新台灯，可自提' } } },
};
```

应用目录的 `larklet.config.js` 决定怎么连飞书。第一项是 `connection`，默认 `websocket`（长连接）。开发者后台的事件订阅和回调订阅都要选「使用长连接接收」。

```js
/** @type {import('larklet').LarkletConfig} */
export default {
  connection: 'websocket',
};
```

改成 `connection: 'webhook'` 后，把请求地址指到 `POST /webhook`。两种方式都认加密密钥（`LARKLET_ENCRYPT_KEY`）和校验 token（`LARKLET_VERIFICATION_TOKEN`）。配置了校验 token 时，HTTP 请求必须带上它，缺失或不匹配一律 401；长连接用 `APP_ID` / `APP_SECRET` 握手鉴权，不走 token 比对。没配凭证时本地预览照常开，只是不会连上飞书。

机器人自定义菜单（事件类型 `application.bot.menu_v6`）和访问端点是同一条路：`event_key` 就是路径，例如 `guide` 或 `/ticket/42?from=menu`。用户私聊发送 `/guide`，或在群聊里 `@机器人 /guide`，同样会把斜杠后的内容当作 `event_key`（需订阅 `im.message.receive_v1`）。

应用目录下的 `app/catalog.ts`（也认 `.tsx` / `.jsx` / `.js`）列出配套网页可发送的应用。加号菜单里要显示这份目录，网页得注册 `registerPlusMenu(appCatalogMenu())`，并且知道 Larklet 进程的地址（`LARKLET_CARD_RENDER_URL`）：

```ts
export const apps = [{ href: '/ticket/REQ-42', title: '审批单', description: '打开一张审批单' }];
```

页面可以导出 `aliases`，让另一条路径打开同一张卡片。别名与页面路径同形，动态段沿用原来的参数名；只写静态前缀时，尾部动态段会补上。中文路径不用编码。命中别名后，卡片里记下的仍是页面自己的路径，所以 `/工单/42` 与 `/ticket/42` 是同一张卡片。两条路径不能指向不同页面。

```tsx
// app/guide/page.tsx
export const aliases = ['指引'];

// app/ticket/[id]/page.tsx — `工单` 等价于 `工单/[id]`
export const aliases = ['工单'];
```

Larklet 渲染这张卡片；这两类事件都没有卡片回传体。配置了应用凭证时：菜单点击与私聊斜杠命令会私聊给操作者，群聊斜杠命令则发到该群。应用需要开通「以应用的身份发消息」。没有凭证时 `handle()` 仍返回 `{ type: 'menu', card }`，由调用方自己发送。

飞书应用凭证成对配置：`createLarklet({ appId, appSecret })`，或环境变量 `LARKLET_APP_ID` / `LARKLET_APP_SECRET`（也认 `APP_ID` / `APP_SECRET`）。`larklet dev|start` 会读取 `--dir` 下的 `.env`，已有环境变量优先。卡片渲染和 Server Action 里用 `feishuCredentials()` 读取；未配置时返回 `undefined`。只填其中一项会启动失败。inbox 示例的页眉会显示当前 `app_id`。

## 配套网页

每个机器人旁边有一个网页，从飞书消息菜单的快捷操作打开，也从聊天框加号菜单打开。它使用飞书当前用户，不另建账号。

从消息的「…」菜单打开时，网页显示当前用户、消息 ID（`open_message_id`）和消息类型。任何消息类型都能打开——文本、图片、富文本、文件、视频、卡片都一样，不只卡片。

消息类型**先用机器人身份读**：机器人在这条消息的会话里时（开放平台要求「机器人必须在消息所属的群组内」），不用用户授权就能读到类型，页面也不会弹授权框。当前用户走网页应用免登（OAuth 2.0）拿 `user_access_token`，只要登录信息（`open_id`、姓名、头像），不申请任何权限。

机器人不在那个会话里时，只有当前用户自己读得到消息，这时才需要用户授权：页面会让用户授权 `im:message`（单聊还要 `im:message.p2p_msg:get_as_user`，群聊要 `im:message.group_msg:get_as_user`），授权后照样能读到类型。没授权时页面上留了按钮可以再授权一次。

这两类权限都在开放平台后台的**权限管理 → 用户身份权限**里开通，开完要**重新发布应用**。申请了应用没开通的权限，飞书会直接报错（`20027`，「当前应用权限不足」），授权整个中断 —— 所以读消息这条路上不会去申请发消息的权限。`im:message.send_as_user` 只有「以用户身份发消息」那个功能才要，普通读消息用不到。

从聊天框加号菜单打开时，网页显示当前会话（`chat_id` 与会话名）和当前用户，两者都用飞书当前登录的人，不另建账号。当前会话由网页用 JSAPI `getTriggerContext` 读 triggerCode 换出来，用户信息走网页应用免登——加号菜单只要用户身份，免登时不申请增量权限，用户不会看到授权弹窗。

要在加号菜单里放自己的内容，导出 `registerPlusMenu` 注册一段渲染，内容显示在会话与用户信息下面：

```tsx
// apps/web/src/main.tsx
import { CompanionPage, registerPlusMenu } from 'larklet-web/client';

registerPlusMenu({
  title: '创建工单',
  render: (ctx) => <MyForm chatId={ctx.chatId} user={ctx.user} />,
});
```

`ctx` 里有当前会话（`chatId`、`chatName`）、当前用户（`openId`、`name`、`avatarUrl`）、机器人的应用目录（`apps`），以及 `chooseTargetChat` 和 `requestUserToken` 两个要授权才用的动作。想保留「列出应用、点一下把卡片发到会话」，注册现成的目录即可：

```tsx
import { appCatalogMenu, registerPlusMenu } from 'larklet-web/client';

registerPlusMenu(appCatalogMenu());
```

目录里的应用可以在 `registerAppDetail` 里换成自己的详情页：

```tsx
import { registerAppDetail } from 'larklet-web/client';

registerAppDetail('/ticket/REQ-42', {
  title: '审批单',
  render: (ctx) => <TicketForm chatId={ctx.chatId} />,
});
```

飞书后台要分别给这个网页应用开两个场景：「消息快捷操作」和「聊天框『+』菜单」。桌面端的两个场景都要在会话内打开，AppLink 用 `mode=sidebar`；移动端填网页地址即可。

**两个场景要配不同的路径。** 飞书客户端会复用同一个侧边栏页面，AppLink 的 `reload` 默认是 `false`——当前页面路径和要打开的路径相同时，客户端保留原页面，上一次的启动参数也就留着了：从加号菜单打开过页面，再从消息的「…」菜单进来，页面还以为自己是加号菜单。给两个场景不同的 `path` 就没这个毛病，网页按路径认场景：

| 场景 | AppLink |
| --- | --- |
| 消息快捷操作 | `https://applink.feishu.cn/client/web_app/open?appId=xxx&mode=sidebar&path=/message` |
| 聊天框「+」菜单 | `https://applink.feishu.cn/client/web_app/open?appId=xxx&mode=sidebar&path=/plus` |

`path` 只能用路径，不能带 query；`/message` 与 `/plus` 这两个名字是约定，网页按路径的最后一段认场景。不想配不同路径也行，那就在 AppLink 里加 `reload=true`（PC 5.20+）：路径相同时重新加载页面，代价是每次都丢掉页面状态。

改完场景要**发布新版本**才会生效。没发布的话，消息的「…」菜单里根本不会出现这个应用。


`create-larklet` 会生成一个 pnpm workspace：`apps/bot` 是 Larklet 卡片应用，`apps/web` 是配套网页。网页用 Vite、React 和 Semi Design，主题是飞书 Universe Design（`@semi-bot/semi-theme-universedesign`）。

```bash
pnpm create-larklet ../my-bot
cd ../my-bot
pnpm install
cp .env.example .env
pnpm dev
pnpm dev:web
```

生成工程里的 `larklet` 与 `larklet-web` 取 npm 上的版本，版本号跟随 `create-larklet` 自己。飞书后台把消息快捷操作的地址指到 web；应用需要读取消息、以应用身份发消息，并让用户授权 `im:message` 与 `im:message.send_as_user`。以用户身份读消息还要开 `im:message.group_msg:get_as_user`（群聊）和 `im:message.p2p_msg:get_as_user`（单聊）——机器人不在的群里，只有这两项能让用户自己读到那条消息。

工程根目录还带一份 `.mcp.json`，注册 `feishu-doc` MCP（`npx feishu-doc-mcp@latest`），方便 Claude Code 查飞书开放平台文档。

用户身份走 OAuth 2.0 的 `POST https://accounts.feishu.cn/oauth/v3/token`（旧的 `authen/v1/access_token`、`authen/v2/oauth/token` 都已是历史版本），再用 `user_access_token` 调 `authen/v1/user_info` 取 `open_id` / `union_id` / 姓名和头像。国际版把开放平台域名设成 `Lark` 或 `https://open.larksuite.com`，账号域名随之变成 `accounts.larksuite.com`。

网页在浏览器里的飞书环境判定会同时看 UA 和 H5 SDK：`h5-js-sdk` 在任意浏览器都会给 `window.tt` / `window.h5sdk` 赋值，只看全局对象会把普通浏览器误判成飞书。JSSDK 鉴权失败时会降级成本地预览，而不是整页报错。

`larklet dev` / `larklet start` 会按配置连上飞书：长连接收到卡片点击后，把新卡片从同一条连接回传；菜单和斜杠命令没有回传体，由机器人发到对应会话（群聊进群，否则私聊）。自己收事件时也可以走同一个入口：

### 事件

所有飞书事件走同一个入口：`im.message.receive_v1`、`im.chat.member.user.added_v1`、`contact.user.deleted_v3`、`im.chat.updated_v1`、链接预览回调 `url.preview.get`……不区分订阅方式，也不区分 1.0 / 2.0。

在应用目录写 `app/events.ts`，按事件类型注册处理函数：

```ts
// app/events.ts
export const events = {
  'im.message.receive_v1': async (event) => {
    const message = event.event.message as { chat_id?: string; content?: string };
    await myOwnHandler(message?.chat_id, message?.content);
    return { code: 0 }; // 已接管
  },
  'im.chat.member.user.added_v1': async (event) => {
    await welcome(event.event.chat_id as string);
    // 不返回则继续后面的处理函数 / 默认分发
  },
  'im.chat.*': async (event) => logEvent(event), // 前缀通配
  '*': async (event) => logUnknown(event),       // 兜底
};
```

也可以默认导出单个函数，等价于 `'*'`；或者在 `createLarklet({ onEvent })` 里内联注册，支持同样的函数形式或对象形式。内联的 `onEvent` 先于 `app/events.ts` 运行。匹配顺序：精确类型 → 通配（按声明顺序）→ 兜底。

处理函数拿到统一的 `LarkletEvent`：

| 字段 | 说明 |
| --- | --- |
| `eventType` | 事件类型，例如 `im.message.receive_v1` |
| `header` | 2.0 的 `header`；1.0 事件由 `uuid` / `token` / `event.type` 补成同形 |
| `event` | 事件正文，字段随事件类型而定，不做裁剪 |
| `body` | 原始请求体（webhook）或原始帧（长连接） |
| `eventId` | 2.0 的 `header.event_id`，1.0 的 `uuid`；用来做幂等 |
| `token` | 应用校验 token；长连接上通常没有 |
| `transport` | `webhook` / `socket` / `http` |
| `version` | `1.0` / `2.0` |

返回非 `undefined` 表示接管：HTTP 入口把返回值原样作为响应体（链接预览回调就是靠它回数据），长连接把它回传给飞书。返回 `undefined` 则继续走卡片回调 / 菜单 / 斜杠命令的默认分发。本地预览自己拼的卡片回调标记为 `synthetic`，不会进入事件处理函数。`readEvent(body)` 也从包入口导出，自己接传输层时可以直接用。

事件处理函数都没接管时，`im.message.receive_v1` 里没命中路由的消息会交给[对话 Agent](#对话-agent)（应用写了 `app/agent.ts` 才有）。

```ts
const handled = await app.handle(event);
if (handled.type === 'card') return toCallbackResponse(handled);
```

### 回一句话

事件处理函数里最常做的是回一条消息。`sendText(receiveIdOrChatId, text)` 收 `open_id` 或 `chat_id`，按 `oc_` 前缀自动选 `receive_id_type`，凭证用当前上下文或 `LARKLET_APP_ID` / `LARKLET_APP_SECRET`，不用自己取 token、拼 `im/v1/messages`：

```ts
// app/events.ts
import { sendText } from 'larklet';

export const events = {
  'im.message.receive_v1': async (event) => {
    const message = event.event.message as { chat_id: string; content: string };
    const { text } = JSON.parse(message.content) as { text: string };
    await sendText(message.chat_id, `收到：${text}`);
    return { code: 0 };
  },
};
```

需要自己拿 token 时用 `postText({ accessToken, receiveId, text })`，参数和 `postInteractiveCard` 一致。两个函数都返回 `{ messageId }`。

首次把卡片发到会话里：`const { card } = await app.render('/ticket/REQ-42')`，把 `card` 作为消息内容发出去。之后的点击由回调换成新的卡片 JSON。

`listen()` 还接受 `onReady`，在 HTTP 监听和长连接就绪之后把装配好的 `app` 交出来；返回的清理函数会在 `close()` 时执行。用它挂自己的 OAuth 回调、定时任务或其它 HTTP 路由：

```ts
const running = await listen({
  dir: process.cwd(),
  onReady: (app) => {
    const timer = setInterval(() => void pollExternal(app), 60_000);
    return () => clearInterval(timer);
  },
});
```

自己接传输层时，`handle()` 之外这些能力也从包入口导出，不必再直接依赖 `@larksuiteoapi/node-sdk` 或重写一遍：`tenantAccessToken`、`resolveOpenApiBase`、`sendInteractiveCard`、`postInteractiveCard`、`sendText`、`postText`、`deliverMenuCard`、`envelopeFromSocket`、`envelopeHref` / `cardHref`、`readEnvelope`、`normalizeIncoming`、`decryptBody`。长连接的事件是摊平的，`envelopeFromSocket(eventType, data, header)` 会还原成 `handle()` 认的 `{ header, event }`，并保留 `token`、`tenant_key` 和 `event_id`。

## 对话 Agent

机器人默认只回「已配置路由」的消息：机器人菜单、斜杠命令 `/guide`。用户私聊发一句「今天怎么样」，没有任何路由命中，消息会被丢掉。

写了 `app/agent.ts` 之后，没命中路由的消息交给对话 Agent 应答：

```ts
// app/agent.ts
import { defineAgent } from 'larklet';

export const agent = defineAgent({
  systemPrompt: '你是订单助手，回答简短。',
  requireMention: true,   // 群里必须 @ 机器人才回。私聊不受影响
  historyLimit: 30,       // 每次回复带多少条历史
  staleThresholdMs: 300_000, // 过期的事件不处理
});
```

模型的接口走 OpenAI 兼容协议，配置在 `.env`：

```
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4.1-mini
```

也认 `LARKLET_LLM_BASE_URL` / `LARKLET_LLM_API_KEY` / `LARKLET_LLM_MODEL`，优先于上面这组。

模型运行时是 `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai`。它们是 larklet 的**可选依赖**：应用自己装上这两个包，larklet 只在真的存在 `app/agent.ts` 时才加载它们。`create-larklet <目录> --agent` 会一并把依赖、`app/agent.ts` 和 `.env.example` 里的模型配置生成好。

### 消息怎么走

| 顺序 | 谁处理 |
| --- | --- |
| 1 | `app/events.ts` 里注册的事件处理函数。返回非 `undefined` 就到此为止 |
| 2 | 对话 Agent。只接 `im.message.receive_v1`，且正文不是斜杠命令 |
| 3 | 默认分发：斜杠命令走菜单路由，卡片回调走对应页面 |

Agent 接管后会立刻回执 `{ code: 0 }`，模型那一轮在后台跑 —— 飞书的事件回执不能等模型。

一轮里发生的事：

- 同一会话同时只跑一轮。新消息到了，上一轮中止，不再发消息。
- 给用户那条消息点一个 `OnIt` 表情表示处理中，结束或被中止时摘掉。
- 拼提示词：最近的历史（`im/v1/messages` 拉的，只取当前这条之前的）+ 当前消息。
- 模型通过 `reply_text` 工具回话，内容是纯文本。模型没调工具但吐了纯文本，就把那段发出去；两者都没有，回一句「抱歉，刚刚处理消息时出了点问题，请稍后再试。」。

机器人自己发的、别的机器人发的、超过 `staleThresholdMs` 的消息都不进模型。私聊直接回，群里要 @ 机器人。

`app.agent.idle()` 等所有在跑的轮次结束。`listen()` 关闭时会先等它，免得回复发不出去。

### 开放平台权限

订阅 `im.message.receive_v1`，并开通：

- 读取用户发给机器人的单聊消息
- 读取用户在群组中 @ 机器人的消息
- 以应用身份发消息
- 获取单聊、群聊的历史消息（用来带上下文）
- 消息表情回复（处理中那个 `OnIt`，没开也不影响回话）

### 自己加工具

除了内置的 `reply_text`，可以给模型更多工具。工具结构与 `@earendil-works/pi-agent-core` 的 `AgentTool` 一致：

```ts
import { defineAgent } from 'larklet';
import { Type } from '@earendil-works/pi-ai';

export const agent = defineAgent({
  systemPrompt: '你是订单助手。',
  tools: [
    {
      name: '查订单',
      label: '查订单',
      description: '按订单号查订单状态。',
      parameters: Type.Object({ id: Type.String({ description: '订单号' }) }),
      execute: async (_id, params) => {
        const { id } = params as { id: string };
        return { content: [{ type: 'text', text: await lookup(id) }], details: {} };
      },
    },
  ],
});
```

## 链接与侧边栏

卡片按钮的 `url` 只写 `default_url`，PC 端会用系统浏览器打开，飞书 JSAPI 全部失效。要在 PC 客户端内嵌侧边栏里打开网页（例如外部 OAuth 回跳），用 `openLink()` 包一层：

```tsx
import { Button, openLink } from 'larklet/card';

<Button url={openLink('https://bot.example/oauth/start')}>去授权</Button>;
// https://applink.feishu.cn/client/web_url/open?mode=sidebar-semi&url=https%3A%2F%2Fbot.example%2Foauth%2Fstart
```

`mode` 可选 `sidebar-semi`（默认，侧边栏）、`window`（独立窗口）、`appCenter`（导航栏标签页，飞书 7.5+）；换窗口尺寸可传 `height` / `width` / `minWidth` / `maxWidth`。国际版传 `{ domain: 'lark' }` 用 `applink.larksuite.com`。`sidebar` 只属于「打开网页应用」（`web_app/open`），不能用在 `web_url/open` 上。

同一模块还提供 `openChat()` 和 `openBot()`，在卡片里把用户带回某个会话：

```tsx
import { openChat, openBot } from 'larklet/card';

<Button url={openChat({ openChatId: 'oc_...' })}>回到群聊</Button>;
<Button url={openBot('cli_...')}>和机器人聊聊</Button>;
```

协议与参数见开放平台「AppLink 协议」下的「端内 web-view 访问指定 URL」「打开聊天页面」「打开机器人会话」。

## 发布

`larklet`、`larklet-web`、`create-larklet` 同版本发布到 npm，由 GitHub Actions 用 OIDC trusted publishing 完成，仓库里不存 token。

```bash
pnpm release patch    # 0.1.0 -> 0.1.1
pnpm release minor    # -> 0.2.0
pnpm release 1.0.0    # 直接指定
```

脚本会先跑 typecheck 和测试，再把三个包的版本对齐、提交 `release: vX.Y.Z`、打 tag，确认后推送到 origin。`v*` tag 会触发 `.github/workflows/publish.yml`，按 `larklet`、`larklet-web`、`create-larklet` 的顺序发布。`--yes` 跳过确认；非交互环境只提交和打 tag，推送由人工完成。
