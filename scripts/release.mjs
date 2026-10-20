#!/usr/bin/env node
/**
 * 同步三个包的版本号，提交、打 tag，推上去后由 GitHub Actions 发布。
 *
 *   pnpm release patch        # 0.1.0 -> 0.1.1
 *   pnpm release minor        # 0.1.0 -> 0.2.0
 *   pnpm release 0.2.0        # 直接指定
 *   pnpm release patch --yes  # 不询问，直接推
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['larklet', 'larklet-web', 'create-larklet'];

function run(command, options = {}) {
  return execSync(command, { cwd: root, stdio: 'inherit', ...options });
}

function output(command) {
  return execSync(command, { cwd: root, encoding: 'utf8' }).trim();
}

function manifestPath(name) {
  return path.join(root, 'packages', name, 'package.json');
}

function readVersion(name) {
  return JSON.parse(fs.readFileSync(manifestPath(name), 'utf8')).version;
}

function writeVersion(name, version) {
  const file = manifestPath(name);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function bump(current, target) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (target === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (target === 'minor') return `${major}.${minor + 1}.0`;
  if (target === 'major') return `${major + 1}.0.0`;
  if (/^\d+\.\d+\.\d+$/.test(target)) return target;
  throw new Error(`版本参数只能是 patch / minor / major / x.y.z，收到：${target}`);
}

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith('--'));
const assumeYes = args.includes('--yes');

if (!target) {
  console.error('用法: pnpm release <patch|minor|major|x.y.z> [--yes]');
  process.exit(1);
}

const versions = new Set(PACKAGES.map(readVersion));
if (versions.size !== 1) {
  console.error(`三个包版本不一致：${[...versions].join(', ')}，先手动对齐再发版。`);
  process.exit(1);
}

const current = [...versions][0];
let next;
try {
  next = bump(current, target);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const tag = `v${next}`;

if (output('git status --porcelain')) {
  console.error('工作区不干净，先提交或还原改动。');
  process.exit(1);
}
if (output('git branch --show-current') !== 'main') {
  console.error('请在 main 分支上发版。');
  process.exit(1);
}
if (output('git tag --list').split('\n').includes(tag)) {
  console.error(`tag ${tag} 已存在。`);
  process.exit(1);
}

console.log(`\n${current} -> ${next}（${PACKAGES.join(', ')}）\n`);

run('pnpm -r --if-present typecheck');
run('pnpm test');

for (const name of PACKAGES) writeVersion(name, next);

run(`git add ${PACKAGES.map((name) => `packages/${name}/package.json`).join(' ')}`);
run(`git commit -m ${JSON.stringify(`release: ${tag}`)}`);
run(`git tag ${tag}`);

if (!assumeYes) {
  if (!process.stdin.isTTY) {
    console.log(`\n非交互环境，已本地提交并打 tag。确认后手动推送：git push && git push origin ${tag}`);
    process.exit(0);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`推送到 origin/main 并推送 ${tag}？（会触发 npm 发布）[y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log(`\n已本地提交并打 tag。稍后手动推送：git push && git push origin ${tag}`);
    process.exit(0);
  }
}

run('git push');
run(`git push origin ${tag}`);
console.log(`\n已推送 ${tag}，Actions 会依次发布三个包。`);
