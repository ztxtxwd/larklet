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

改成 `connection: 'webhook'` 后，把请求地址指到 `POST /webhook`。两种方式都认加密密钥（`LARKLET_ENCRYPT_KEY`）和校验 token（`LARKLET_VERIFICATION_TOKEN`）。长连接还需要 `APP_ID` / `APP_SECRET`；没配凭证时本地预览照常开，只是不会连上飞书。

机器人自定义菜单（事件类型 `application.bot.menu_v6`）和访问端点是同一条路：`event_key` 就是路径，例如 `guide` 或 `/ticket/42?from=menu`。用户私聊发送 `/guide`，或在群聊里 `@机器人 /guide`，同样会把斜杠后的内容当作 `event_key`（需订阅 `im.message.receive_v1`）。

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

每个机器人旁边有一个网页，从飞书消息菜单的快捷应用打开。它使用飞书当前用户，不另建账号。在机器人所在的任意会话里，对一张卡片消息打开这个网页，目前可以把它再发出去：以机器人身份，或以当前用户身份。

`create-larklet` 会生成一个 pnpm workspace：`apps/bot` 是 Larklet 卡片应用，`apps/web` 是配套网页。网页用 Vite、React 和 Semi Design，主题是飞书 Universe Design（`@semi-bot/semi-theme-universedesign`）。

```bash
pnpm create-larklet ../my-bot
cd ../my-bot
pnpm install
cp .env.example .env
pnpm dev
pnpm dev:web
```

生成工程里的 `larklet` 与 `larklet-web` 取 npm 上的版本，版本号跟随 `create-larklet` 自己。飞书后台把消息快捷操作的地址指到 web；应用需要读取消息、以应用身份发消息，并让用户授权 `im:message` 与 `im:message.send_as_user`。

`larklet dev` / `larklet start` 会按配置连上飞书：长连接收到卡片点击后，把新卡片从同一条连接回传；菜单和斜杠命令没有回传体，由机器人发到对应会话（群聊进群，否则私聊）。自己收事件时也可以走同一个入口：

```ts
import { createLarklet, toCallbackResponse } from 'larklet';

const app = await createLarklet({ dir: process.cwd() });
const handled = await app.handle(event);
if (handled.type === 'card') return toCallbackResponse(handled);
```

首次把卡片发到会话里：`const { card } = await app.render('/ticket/REQ-42')`，把 `card` 作为消息内容发出去。之后的点击由回调换成新的卡片 JSON。
