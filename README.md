# Flick

飞书交互卡片的服务端框架。一张卡片就是一个页面，点击就是一次 Server Action，webhook / 长连接只是传输层。

底层卡片 JSON、JSX 和卡片内状态沿用 [`@open-feishu-card`](../@open-feishu-card)：`components` 把 TSX 收成 Schema 2.0，`store` 把状态封印进卡片。Flick 补上 Next.js App Router 那一层。

## 对照

| Next.js | Flick |
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
| `next dev` | `flick dev`：本地预览里点按钮，走同一套回调 |

飞书回调不带回整张卡片，所以路由和 `cardState` 会压缩进每个交互组件的 `value.__flick`，同时用 `@open-feishu-card/store` 封印一份，方便从 `raw_card_content` 回读。

## 应用

```tsx
// app/layout.tsx
import { Card, Header } from 'flick/card';

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
import { Button, Markdown, bindAction } from 'flick/card';
import { getCardState, redirect, setCardState } from 'flick';

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
    "jsxImportSource": "flick",
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

应用目录的 `flick.config.js` 决定怎么连飞书。第一项是 `connection`，默认 `websocket`（长连接）。开发者后台的事件订阅和回调订阅都要选「使用长连接接收」。

```js
/** @type {import('flick').FlickConfig} */
export default {
  connection: 'websocket',
};
```

改成 `connection: 'webhook'` 后，把请求地址指到 `POST /webhook`。两种方式都认加密密钥（`FLICK_ENCRYPT_KEY`）和校验 token（`FLICK_VERIFICATION_TOKEN`）。长连接还需要 `APP_ID` / `APP_SECRET`；没配凭证时本地预览照常开，只是不会连上飞书。

机器人自定义菜单（事件类型 `application.bot.menu_v6`）和访问端点是同一条路：`event_key` 就是路径，例如 `guide` 或 `/ticket/42?from=menu`。用户私聊发送 `/guide`，或在群聊里 `@机器人 /guide`，同样会把斜杠后的内容当作 `event_key`（需订阅 `im.message.receive_v1`）。

页面可以导出 `aliases`，让另一条路径打开同一张卡片。别名与页面路径同形，动态段沿用原来的参数名；只写静态前缀时，尾部动态段会补上。中文路径不用编码。命中别名后，卡片里记下的仍是页面自己的路径，所以 `/工单/42` 与 `/ticket/42` 是同一张卡片。两条路径不能指向不同页面。

```tsx
// app/guide/page.tsx
export const aliases = ['指引'];

// app/ticket/[id]/page.tsx — `工单` 等价于 `工单/[id]`
export const aliases = ['工单'];
```Flick 渲染这张卡片；这两类事件都没有卡片回传体。配置了应用凭证时：菜单点击与私聊斜杠命令会私聊给操作者，群聊斜杠命令则发到该群。应用需要开通「以应用的身份发消息」。没有凭证时 `handle()` 仍返回 `{ type: 'menu', card }`，由调用方自己发送。

飞书应用凭证成对配置：`createFlick({ appId, appSecret })`，或环境变量 `FLICK_APP_ID` / `FLICK_APP_SECRET`（也认 `APP_ID` / `APP_SECRET`）。`flick dev|start` 会读取 `--dir` 下的 `.env`，已有环境变量优先。卡片渲染和 Server Action 里用 `feishuCredentials()` 读取；未配置时返回 `undefined`。只填其中一项会启动失败。inbox 示例的页眉会显示当前 `app_id`。

`flick dev` / `flick start` 会按配置连上飞书：长连接收到卡片点击后，把新卡片从同一条连接回传；菜单和斜杠命令没有回传体，由机器人发到对应会话（群聊进群，否则私聊）。自己收事件时也可以走同一个入口：

```ts
import { createFlick, toCallbackResponse } from 'flick';

const app = await createFlick({ dir: process.cwd() });
const handled = await app.handle(event);
if (handled.type === 'card') return toCallbackResponse(handled);
```

首次把卡片发到会话里：`const { card } = await app.render('/ticket/REQ-42')`，把 `card` 作为消息内容发出去。之后的点击由回调换成新的卡片 JSON。
