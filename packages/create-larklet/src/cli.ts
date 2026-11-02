import { scaffold } from './scaffold.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.error('用法: create-larklet <目录> [--agent]');
  console.error('创建一个 pnpm workspace：apps/bot 是 Larklet 机器人，apps/web 是飞书消息快捷应用。');
  console.error('--agent 一并生成对话 Agent（apps/bot/app/agent.ts），机器人会回复没命中路由的消息。');
  process.exit(0);
}

const dest = args.find((arg) => !arg.startsWith('-'));
const agent = args.includes('--agent');

if (!dest) {
  console.error('用法: create-larklet <目录> [--agent]');
  console.error('创建一个 pnpm workspace：apps/bot 是 Larklet 机器人，apps/web 是飞书消息快捷应用。');
  process.exit(1);
}

try {
  const created = scaffold(dest, { agent });
  console.log(`已创建 ${created.dest}`);
  console.log('');
  console.log('接下来：');
  console.log(`  cd ${dest}`);
  console.log('  pnpm install');
  console.log('  cp .env.example .env   # 填写 APP_ID / APP_SECRET');
  if (agent) {
    console.log('                              # 以及 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL');
  }
  console.log('  pnpm dev               # 机器人预览');
  console.log('  pnpm dev:web           # 配套网页');
  if (agent) {
    console.log('');
    console.log('对话 Agent 已就位：私聊机器人发一句话试试。');
    console.log('开放平台要订阅 im.message.receive_v1，并开通：读单聊消息、读群内 @ 消息、');
    console.log('以应用身份发消息、读历史消息。');
    console.log('注意：对话 Agent 随 larklet 的新版本提供。npm 上还没有这个版本之前，');
    console.log('      把 apps/bot/package.json 里的 larklet 指向本地构建，否则 typecheck 过不去。');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
