/**
 * 本地联调房间。网页进程把卡片推进来，预览页用 SSE 接到同一群里。
 * 只在 `larklet dev` 使用。真机回调不读这里。
 */

import { onResetPreviewContext, rememberPreviewPerson } from './preview-context.js';
import type { Operator } from './request.js';

export interface PreviewRoomUser {
  openId: string;
  userId: string;
  unionId: string;
  name: string;
  avatar: string;
  role: 'seller' | 'buyer';
}

export interface PreviewRoomMessage {
  messageId: string;
  kind: 'chat' | 'ephemeral';
  path: string;
  html: string;
  card: unknown;
  /** 仅特定人可见时的收件人。 */
  openId?: string;
}

export interface PreviewRoomSnapshot {
  id: string;
  seq: number;
  chatId: string;
  users: PreviewRoomUser[];
  messages: PreviewRoomMessage[];
}

interface Room extends PreviewRoomSnapshot {
  listeners: Set<(snapshot: PreviewRoomSnapshot) => void>;
  nextBuyer: number;
}

const BUYER_NAMES = ['小林', '小陈', '阿华', '小周', '小李', '阿杰', '小吴', '小赵', '阿宁', '小唐'];
const COLORS = ['3370ff', '00a67e', 'f54a45', 'ff8800', '8b5cf6', '0f6cbd', 'd83931', '2d9d78'];

const rooms = new Map<string, Room>();

onResetPreviewContext(() => {
  rooms.clear();
});

export function previewRoom(id = 'dev'): PreviewRoomSnapshot {
  return snapshot(ensure(id));
}

export function addPreviewBuyer(id = 'dev'): PreviewRoomSnapshot {
  const room = ensure(id);
  const index = room.nextBuyer;
  room.nextBuyer += 1;
  const user = makeUser(buyerName(index), 'buyer', index);
  room.users.push(user);
  remember(user);
  publish(room);
  return snapshot(room);
}

export function subscribePreviewRoom(id: string, listener: (snapshot: PreviewRoomSnapshot) => void): () => void {
  const room = ensure(id);
  room.listeners.add(listener);
  listener(snapshot(room));
  return () => {
    room.listeners.delete(listener);
  };
}

export function deliverPreviewMessage(id: string, message: PreviewRoomMessage): PreviewRoomSnapshot {
  const room = ensure(id);
  const index = room.messages.findIndex((item) => item.messageId === message.messageId);
  if (index >= 0) room.messages[index] = message;
  else room.messages.push(message);
  publish(room);
  return snapshot(room);
}

export function findPreviewRoomByChat(chatId: string): PreviewRoomSnapshot | undefined {
  const room = [...rooms.values()].find((item) => item.chatId === chatId);
  return room ? snapshot(room) : undefined;
}

/** 把一次预览回调的结果写回房间，让其他打开这个群的页面一起更新。 */
export function patchPreviewRoom(
  chatId: string,
  patch: {
    messageId?: string;
    path?: string;
    html?: string;
    card?: unknown;
    ephemeral?: PreviewRoomMessage[];
    deletedEphemeral?: string[];
  },
): void {
  const room = [...rooms.values()].find((item) => item.chatId === chatId);
  if (!room) return;
  let changed = false;
  if (patch.messageId && patch.card) {
    const found = room.messages.find((item) => item.kind === 'chat' && item.messageId === patch.messageId);
    if (found) {
      found.card = patch.card;
      if (typeof patch.html === 'string') found.html = patch.html;
      if (patch.path) found.path = patch.path;
      changed = true;
    }
  }
  if (patch.deletedEphemeral?.length) {
    const gone = new Set(patch.deletedEphemeral);
    const next = room.messages.filter((item) => !gone.has(item.messageId));
    if (next.length !== room.messages.length) {
      room.messages = next;
      changed = true;
    }
  }
  for (const item of patch.ephemeral ?? []) {
    if (item.kind !== 'ephemeral') continue;
    const existing = room.messages.find((message) => message.messageId === item.messageId);
    if (existing) Object.assign(existing, item);
    else room.messages.push(item);
    changed = true;
  }
  if (changed) publish(room);
}

export function previewRoomUser(id: string, openId: string): Operator | undefined {
  const user = ensure(id).users.find((item) => item.openId === openId);
  if (!user) return undefined;
  return {
    openId: user.openId,
    userId: user.userId,
    unionId: user.unionId,
    name: user.name,
    avatar: user.avatar,
  };
}

function ensure(id: string): Room {
  const key = sanitizeId(id);
  const existing = rooms.get(key);
  if (existing) return existing;
  const seller = makeUser('阿明', 'seller', 0);
  const buyers = [1, 2].map((index) => makeUser(buyerName(index), 'buyer', index));
  const room: Room = {
    id: key,
    seq: 0,
    chatId: `oc_larklet_${key}`,
    users: [seller, ...buyers],
    messages: [],
    listeners: new Set(),
    nextBuyer: 3,
  };
  rooms.set(key, room);
  for (const user of room.users) remember(user);
  return room;
}

function publish(room: Room): void {
  room.seq += 1;
  const body = snapshot(room);
  for (const listener of room.listeners) listener(body);
}

function snapshot(room: Room): PreviewRoomSnapshot {
  return {
    id: room.id,
    seq: room.seq,
    chatId: room.chatId,
    users: room.users.map((user) => ({ ...user })),
    messages: room.messages.map((message) => ({ ...message })),
  };
}

function remember(user: PreviewRoomUser): void {
  rememberPreviewPerson({
    openId: user.openId,
    userId: user.userId,
    unionId: user.unionId,
    name: user.name,
    avatar: user.avatar,
  });
}

function makeUser(name: string, role: 'seller' | 'buyer', index: number): PreviewRoomUser {
  const openId = role === 'seller' ? 'ou_larklet_dev_seller' : `ou_larklet_dev_buyer_${index}`;
  const color = COLORS[index % COLORS.length] ?? '3370ff';
  return {
    openId,
    userId: openId.replace(/^ou_/, 'u_'),
    unionId: openId.replace(/^ou_/, 'on_'),
    name,
    avatar: avatarDataUri(name, color),
    role,
  };
}

function buyerName(index: number): string {
  return BUYER_NAMES[(index - 1) % BUYER_NAMES.length] ?? `留言者${index}`;
}

function sanitizeId(id: string): string {
  const cleaned = id.trim().replace(/[^\w-]/g, '').slice(0, 32);
  return cleaned || 'dev';
}

function avatarDataUri(name: string, color: string): string {
  const initial = [...name][0] || '?';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" rx="32" fill="#${color}"/>` +
    `<text x="32" y="42" text-anchor="middle" fill="white" font-size="28" font-family="sans-serif">${initial}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
