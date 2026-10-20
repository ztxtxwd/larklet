import { scaffold } from './scaffold.js';

const dest = process.argv[2];
if (!dest || dest === '--help' || dest === '-h') {
  console.error('用法: create-larklet <目录>');
  console.error('创建一个 pnpm workspace：apps/bot 是 Larklet 机器人，apps/web 是飞书消息快捷应用。');
  process.exit(dest ? 0 : 1);
}

try {
  const created = scaffold(dest);
  console.log(`已创建 ${created.dest}`);
  console.log('');
  console.log('接下来：');
  console.log(`  cd ${dest}`);
  console.log('  pnpm install');
  console.log('  cp .env.example .env   # 填写 APP_ID / APP_SECRET');
  console.log('  pnpm dev               # 机器人预览');
  console.log('  pnpm dev:web           # 配套网页');
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
