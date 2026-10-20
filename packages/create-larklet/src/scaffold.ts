import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../template');

/**
 * 模板里 larklet / larklet-web 的版本，跟随本包清单里的版本号。
 * 三个包同版本发布，所以这里写的就是它们当前的版本。
 */
function dependencyVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as {
    version: string;
  };
  return `^${manifest.version}`;
}

export interface ScaffoldResult {
  dest: string;
  name: string;
}

/** 把 bot + web 的 workspace 写到 `dest`。依赖取 npm 上的 larklet / larklet-web。 */
export function scaffold(destInput: string): ScaffoldResult {
  const dest = path.resolve(destInput);
  const name = packageName(path.basename(dest));
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
    throw new Error(`目录已存在且非空：${dest}`);
  }

  copyTemplate(templateRoot, dest, {
    __APP_NAME__: name,
    __LARKLET_SPEC__: dependencyVersion(),
    __LARKLET_WEB_SPEC__: dependencyVersion(),
  });
  return { dest, name };
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function packageName(dirName: string): string {
  const name = dirName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name || !/^[a-z0-9]/.test(name)) throw new Error('目录名需要以字母或数字开头');
  return name;
}

function copyTemplate(from: string, to: string, replace: Record<string, string>): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTemplate(source, target, replace);
      continue;
    }
    const text = fs.readFileSync(source, 'utf8');
    const next = Object.entries(replace).reduce((content, [token, value]) => content.split(token).join(value), text);
    fs.writeFileSync(target, next);
  }
}
