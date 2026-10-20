export function previewHtml(toastShell: Record<string, string> = {}): string {
  const toastShellJson = JSON.stringify(toastShell).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Larklet</title>
  <link rel="stylesheet" href="/_larklet/renderer.css" />
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #f5f6f7; color: #1f2329; }
    header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 16px; background: #fff; border-bottom: 1px solid #dee0e3; }
    header input[type="text"] { flex: 1; min-width: 160px; font: inherit; padding: 6px 8px; border: 1px solid #dee0e3; border-radius: 6px; }
    header button { font: inherit; padding: 6px 10px; border-radius: 6px; border: 1px solid #dee0e3; background: #fff; cursor: pointer; }
    body.embed #path, body.embed #go { display: none; }
    #hint { font-size: 12px; color: #8f959e; }
    #board { display: flex; flex-direction: column; gap: 28px; align-items: stretch; overflow-x: auto; padding: 16px; }
    .lane { display: flex; flex-direction: column; gap: 8px; }
    .lane-title { margin: 0; font-size: 13px; color: #646a73; }
    .lane-row { display: flex; gap: 16px; align-items: flex-start; }
    .stack { width: 420px; flex: 0 0 420px; display: flex; flex-direction: column; gap: 12px; }
    .chat-note { margin: 12px 0 0; padding: 10px 12px; background: #fff; border-radius: 8px; white-space: pre-wrap; }
    .pane { width: 100%; }
    .pane.ephemeral { outline: 1px dashed #7b61ff; outline-offset: 4px; border-radius: 8px; }
    .pane.ephemeral.nested .pane-bar img,
    .pane.ephemeral.nested .pane-bar .meta { display: none; }
    .pane.ephemeral.nested .pane-bar { justify-content: flex-end; margin-bottom: 0; }
    .pane-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .pane-bar img { width: 28px; height: 28px; border-radius: 50%; background: #e8e9eb; flex-shrink: 0; }
    .pane-bar .meta { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; flex: 1; }
    .pane-bar .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pane-bar .id { font-size: 11px; color: #8f959e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pane-bar button { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid #dee0e3; background: #fff; cursor: pointer; }
    .where { font-size: 12px; color: #8f959e; margin: 0 0 8px; }
    .screen { position: relative; }
    /* 真机 toast 宿主是整窗 fixed；预览里每人一栏，浮在这一栏的卡片上 */
    .screen .universal-card-toast-host {
      position: absolute;
      top: 8px;
      left: 50%;
      width: max-content;
      max-width: calc(100% - 16px);
    }
    .screen .universal-card-toast { max-width: 100%; }
    .stage { background: transparent; }
  </style>
</head>
<body>
  <header>
    <strong>Larklet</strong>
    <input id="path" type="text" value="/" aria-label="路径" />
    <button id="go" type="button">打开</button>
    <button id="add-user" type="button">加一位留言者</button>
    <span id="hint">再打开同一路径会加入这个会话。两个人及以上共享一张卡片。</span>
  </header>
  <div id="board"></div>
  <script>
    const NAMES = ['阿明','小林','小陈','阿华','小周','小李','阿杰','小吴','小赵','阿宁','小唐','阿欣'];
    const COLORS = ['3370ff','00a67e','f54a45','ff8800','8b5cf6','0f6cbd','d83931','2d9d78'];

    const pathInput = document.querySelector('#path');
    const board = document.querySelector('#board');
    const panes = [];
    let nextId = 1;
    const pageParams = new URLSearchParams(location.search);
    const roomId = pageParams.get('room') || 'dev';
    const embed = pageParams.get('embed') === '1';
    let roomSeq = -1;
    if (embed) {
      document.body.classList.add('embed');
      document.querySelector('#hint').textContent = '从网页发布。每个人都能看到群里的卡片，可以在上面留言。';
    } else {
      document.querySelector('#add-user').hidden = true;
    }

    function randomId(prefix) {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    function avatarUrl(name, color) {
      const initial = encodeURIComponent((name || '?').slice(0, 1));
      const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>"
        + "<rect width='64' height='64' rx='32' fill='%23" + color + "'/>"
        + "<text x='32' y='34' text-anchor='middle' dominant-baseline='middle' "
        + "fill='white' font-size='28' font-family='system-ui,sans-serif'>" + initial + "</text></svg>";
      return 'data:image/svg+xml,' + svg;
    }

    function createUser() {
      const used = new Set(panes.map((pane) => pane.user.name));
      const pool = NAMES.filter((name) => !used.has(name));
      const name = (pool.length ? pool : NAMES)[Math.floor(Math.random() * (pool.length || NAMES.length))];
      const color = COLORS[Math.floor(Math.random() * COLORS.length)];
      return {
        openId: randomId('ou_'),
        userId: randomId('u_'),
        unionId: randomId('on_'),
        name,
        avatar: avatarUrl(name, color),
      };
    }

    function normalizePath(value) {
      const raw = (value || '/').trim() || '/';
      const withSlash = raw.startsWith('/') ? raw : '/' + raw;
      const url = new URL(withSlash, 'http://larklet.local');
      let pathname = url.pathname;
      try { pathname = decodeURIComponent(pathname); } catch (error) {}
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      return url.search ? pathname + url.search : pathname;
    }

    function peers(pane) {
      return panes.filter((item) => !item.ephemeral && item.sessionId === pane.sessionId);
    }

    function ownerOf(pane) {
      if (!pane.ephemeral) return pane;
      return panes.find((item) => !item.ephemeral && item.user.openId === pane.user.openId);
    }

    function messageContext(pane) {
      if (pane.ephemeral && pane.ephemeralMessageId) {
        return { open_message_id: pane.ephemeralMessageId, open_chat_id: pane.chatId };
      }
      if (peers(pane).length >= 2) {
        return { open_message_id: pane.sessionId, open_chat_id: pane.chatId };
      }
      return {
        open_message_id: 'om_dm_' + pane.user.openId,
        open_chat_id: 'oc_dm_' + pane.user.openId,
      };
    }

    function unwrapCard(card) {
      if (card && card.type === 'raw' && card.data) return card.data;
      return card;
    }

    function isShared(card) {
      const config = card && card.config;
      return !config || config.update_multi !== false;
    }

    const TOAST_SHELL = ${toastShellJson};

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function showToast(pane, toast) {
      if (!toast || !toast.content) return;
      const type = TOAST_SHELL[toast.type] ? toast.type : 'info';
      const shell = TOAST_SHELL[type];
      if (!shell) return;
      const host = ensurePane(pane).querySelector('.universal-card-toast-host');
      let html = shell.replace('LARKLET_TOAST_CONTENT', escapeHtml(toast.content));
      if (toast.variant === 'outlined') {
        html = html.replace(
          'class="universal-card-toast ',
          'class="universal-card-toast universal-card-toast--outlined ',
        );
      }
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:contents';
      wrap.innerHTML = html;
      const node = wrap.firstElementChild;
      if (!node) return;
      host.appendChild(node);
      setTimeout(() => {
        node.classList.add('universal-card-toast--leave');
        node.addEventListener('animationend', () => node.remove(), { once: true });
        setTimeout(() => node.remove(), 400);
      }, toast.showTime || 2000);
    }

    function paneById(id) {
      return panes.find((pane) => String(pane.id) === String(id));
    }

    function stackKey(pane) {
      const owner = ownerOf(pane);
      return owner ? 'owner-' + owner.id : 'solo-' + pane.user.openId;
    }

    function laneRow(pane) {
      const id = pane.lane || 'room';
      let lane = board.querySelector('.lane[data-lane="' + id + '"]');
      if (!lane) {
        lane = document.createElement('section');
        lane.className = 'lane';
        lane.dataset.lane = id;
        if (id !== 'room') {
          const title = document.createElement('p');
          title.className = 'lane-title';
          title.textContent = '继续沟通';
          lane.appendChild(title);
        }
        const row = document.createElement('div');
        row.className = 'lane-row';
        lane.appendChild(row);
        board.appendChild(lane);
      }
      return lane.querySelector('.lane-row');
    }

    function stackFor(pane) {
      const key = stackKey(pane);
      const row = laneRow(pane);
      let stack = row.querySelector(':scope > .stack[data-stack="' + key + '"]');
      if (stack) return stack;
      stack = document.createElement('div');
      stack.className = 'stack';
      stack.dataset.stack = key;
      row.appendChild(stack);
      return stack;
    }

    function ensurePane(pane) {
      const stack = stackFor(pane);
      let el = board.querySelector('[data-id="' + pane.id + '"]');
      if (!el) {
        el = document.createElement('article');
        el.className = 'pane';
        el.dataset.id = String(pane.id);
        el.innerHTML = ''
          + '<div class="pane-bar">'
          + '<img alt="" />'
          + '<div class="meta"><span class="name"></span><span class="id"></span></div>'
          + '<button type="button" data-close>关闭</button>'
          + '</div>'
          + '<p class="where"></p>'
          + '<div class="screen">'
          + '<div class="universal-card-toast-host"></div>'
          + '<div class="stage"></div>'
          + '</div>';
        const img = el.querySelector('img');
        img.src = pane.user.avatar;
        img.alt = pane.user.name;
      el.querySelector('.name').textContent = displayName(pane.user);
      el.querySelector('.id').textContent = pane.user.openId;
      }
      if (el.parentElement !== stack) stack.appendChild(el);
      return el;
    }

    function paint(pane) {
      const el = ensurePane(pane);
      const grouped = peers(pane).length >= 2;
      el.classList.toggle('ephemeral', !!pane.ephemeral);
      el.classList.toggle('nested', !!pane.ephemeral && !!ownerOf(pane));
      const name = el.querySelector('.name');
      if (name) name.textContent = displayName(pane.user);
      el.querySelector('.where').textContent = pane.lane
        ? '继续沟通 · 群聊'
        : pane.ephemeral
          ? pane.path + ' · 仅此人可见'
          : pane.path + (grouped ? ' · 群聊' : ' · 私聊');
      const stage = el.querySelector('.stage');
      stage.innerHTML = pane.html || '<pre style="padding:12px;white-space:pre-wrap"></pre>';
      if (!pane.html) stage.querySelector('pre').textContent = pane.card ? JSON.stringify(pane.card, null, 2) : '';
      let note = el.querySelector('.chat-note');
      if (pane.previewText) {
        if (!note) {
          note = document.createElement('p');
          note.className = 'chat-note';
          el.querySelector('.screen').appendChild(note);
        }
        note.textContent = pane.previewText;
      } else if (note) {
        note.remove();
      }
    }

    function refresh() {
      for (const el of [...board.querySelectorAll('.pane')]) {
        if (!paneById(el.dataset.id)) el.remove();
      }
      for (const pane of panes) paint(pane);
      for (const pane of panes) {
        if (pane.ephemeral) continue;
        const stack = stackFor(pane);
        const el = board.querySelector('[data-id="' + pane.id + '"]');
        if (el) stack.appendChild(el);
        if (pane.lane) continue;
        for (const child of panes) {
          if (!child.ephemeral || child.user.openId !== pane.user.openId) continue;
          const childEl = board.querySelector('[data-id="' + child.id + '"]');
          if (childEl) stack.appendChild(childEl);
        }
      }
      for (const stack of [...board.querySelectorAll('.stack')]) {
        if (!stack.querySelector('.pane')) stack.remove();
      }
      for (const lane of [...board.querySelectorAll('.lane')]) {
        if (!lane.querySelector('.pane')) lane.remove();
      }
    }

    function displayName(user) {
      if (!user) return '';
      if (user.role === 'seller') return user.name + ' · 发布者';
      if (user.role === 'buyer') return user.name + ' · 留言者';
      return user.name || '';
    }

    function applyRoom(snap) {
      if (!snap || typeof snap.seq !== 'number' || snap.seq <= roomSeq) return;
      roomSeq = snap.seq;
      const live = new Set();
      const messages = snap.messages || [];
      if (!messages.length) {
        for (const user of snap.users || []) {
          const roomKey = 'wait:' + user.openId;
          live.add(roomKey);
          upsertRoomPane(roomKey, {
            user,
            path: '等待卡片',
            sessionId: 'wait-' + user.openId,
            chatId: snap.chatId,
            html: '<p style="margin:0;padding:12px;color:#8f959e">还没有卡片。在网页里发布后，会出现在这里。</p>',
            card: null,
            ephemeral: false,
          });
        }
      }
      for (const message of messages) {
        if (message.kind === 'ephemeral') {
          const user = (snap.users || []).find((item) => item.openId === message.openId);
          if (!user) continue;
          const roomKey = message.messageId + ':' + message.openId;
          live.add(roomKey);
          upsertRoomPane(roomKey, {
            user,
            path: message.path || '/',
            sessionId: message.messageId,
            chatId: snap.chatId,
            html: message.html || '',
            card: unwrapCard(message.card),
            ephemeral: true,
            ephemeralMessageId: message.messageId,
          });
          continue;
        }
        for (const user of snap.users || []) {
          const roomKey = message.messageId + ':' + user.openId;
          live.add(roomKey);
          upsertRoomPane(roomKey, {
            user,
            path: message.path || '/',
            sessionId: message.messageId,
            chatId: snap.chatId,
            html: message.html || '',
            card: unwrapCard(message.card),
            ephemeral: false,
          });
        }
      }
      for (let i = panes.length - 1; i >= 0; i--) {
        if (panes[i].room && !live.has(panes[i].roomKey)) panes.splice(i, 1);
      }
      refresh();
    }

    function upsertRoomPane(roomKey, fields) {
      let pane = panes.find((item) => item.roomKey === roomKey);
      if (!pane) {
        pane = { id: nextId++, room: true, roomKey, pending: undefined };
        panes.push(pane);
      }
      Object.assign(pane, fields, { room: true, roomKey });
    }

    function applyView(pane, data) {
      pane.card = unwrapCard(data.card);
      pane.html = data.html || '';
      pane.path = data.path || pane.path;
    }

    async function fetchRender(pane) {
      const ctx = messageContext(pane);
      const op = pane.user;
      const qs = new URLSearchParams({
        path: pane.path || '/',
        open_id: op.openId,
        user_id: op.userId,
        union_id: op.unionId,
        name: op.name,
        avatar: op.avatar,
        open_message_id: ctx.open_message_id,
        open_chat_id: ctx.open_chat_id,
      });
      const res = await fetch('/_larklet/render?' + qs.toString());
      return res.json();
    }

    function openScene(path, data) {
      if (panes.some((pane) => pane.sceneKey === path)) return;
      const scene = data.scene;
      if (!scene || !Array.isArray(scene.users) || !scene.users.length) return;
      const sessionId = randomId('om_');
      const chatId = randomId('oc_');
      const users = scene.users.map((user, index) => ({
        openId: user.role === 'seller' ? 'ou_preview_seller' : 'ou_preview_buyer_' + index,
        userId: 'u_preview_' + index,
        unionId: 'on_preview_' + index,
        name: user.name,
        role: user.role,
        avatar: avatarUrl(user.name, COLORS[index % COLORS.length]),
      }));
      for (const user of users) {
        panes.push({
          id: nextId++,
          user,
          path: data.path || path,
          sessionId,
          chatId,
          html: data.html || '',
          card: unwrapCard(data.card),
          sceneKey: path,
        });
      }
      const aside = scene.aside;
      if (aside && aside.html) {
        const owner = users.find((user) => aside.role && user.role === aside.role) || users[0];
        panes.push({
          id: nextId++,
          user: owner,
          path: aside.path || path,
          sessionId,
          chatId,
          html: aside.html,
          card: unwrapCard(aside.card),
          ephemeral: true,
          ephemeralMessageId: randomId('om_ephemeral_'),
          sceneKey: path,
        });
      }
      refresh();
    }

    async function openPath(raw) {
      const path = normalizePath(raw);
      pathInput.value = path;
      if (!embed && !panes.some((pane) => pane.sceneKey === path)) {
        const meta = await fetch('/_larklet/preview/scene?path=' + encodeURIComponent(path)).then((res) => res.json());
        if (meta && meta.scene) {
          const rendered = await fetch('/_larklet/render?path=' + encodeURIComponent(path)).then((res) => res.json());
          if (rendered.scene) {
            openScene(path, rendered);
            return;
          }
        }
      }
      const host = panes.find((pane) => pane.path === path && !pane.ephemeral && !pane.sceneKey);
      const user = createUser();
      if (host) {
        const pane = {
          id: nextId++,
          user,
          path: host.path,
          sessionId: host.sessionId,
          chatId: host.chatId,
          html: host.html,
          card: host.card,
          pending: host.pending,
        };
        panes.push(pane);
        refresh();
        if (host.pending) await host.pending;
        if (!panes.includes(pane)) return;
        pane.html = host.html;
        pane.card = host.card;
        pane.path = host.path;
        pane.pending = undefined;
        refresh();
        return;
      }
      const pane = {
        id: nextId++,
        user,
        path,
        sessionId: randomId('om_'),
        chatId: randomId('oc_'),
        html: '',
        card: null,
        pending: undefined,
      };
      panes.push(pane);
      refresh();
      const job = (async () => {
        const data = await fetchRender(pane);
        if (!panes.includes(pane)) return;
        if (data.msg && !data.card) {
          refresh();
          showToast(pane, { type: 'error', content: data.msg });
          return;
        }
        applyView(pane, data);
        refresh();
      })();
      pane.pending = job;
      try {
        await job;
      } finally {
        if (pane.pending === job) pane.pending = undefined;
      }
    }

    async function post(pane, value, formValue, tag) {
      const ctx = messageContext(pane);
      const op = pane.user;
      const res = await fetch('/_larklet/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema: '2.0',
          header: { event_type: 'card.action.trigger', token: 'dev' },
          event: {
            operator: {
              open_id: op.openId,
              user_id: op.userId,
              union_id: op.unionId,
              name: op.name,
              avatar: op.avatar,
            },
            context: ctx,
            action: { tag: tag || 'button', value, form_value: formValue || {} },
          },
        }),
      });
      const data = await res.json();
      const card = unwrapCard(data.card);
      if (!card) {
        refresh();
        showToast(pane, { type: 'error', content: data.msg || '回调失败' });
        return;
      }
      const nextPath = data.path || pane.path;
      if (pane.ephemeral || !isShared(card)) {
        if (!pane.ephemeral && nextPath !== pane.path) {
          pane.sessionId = randomId('om_');
          pane.chatId = randomId('oc_');
        }
        pane.card = card;
        pane.html = data.html || '';
        pane.path = nextPath;
        refresh();
        applyMessages(data);
        applyEphemeral(pane, data);
        showToast(panes.includes(pane) ? pane : ownerOf(pane) || pane, data.toast);
        return;
      }
      for (const member of peers(pane)) {
        member.card = card;
        member.html = data.html || '';
        member.path = nextPath;
      }
      refresh();
      showToast(pane, data.toast);
      applyMessages(data);
      applyEphemeral(pane, data);
    }

    function applyMessages(data) {
      for (const item of data.messages || []) {
        const targets = panes.filter((pane) =>
          pane.ephemeral ? pane.ephemeralMessageId === item.messageId : pane.sessionId === item.messageId,
        );
        if (targets.length) {
          for (const target of targets) {
            target.card = unwrapCard(item.card);
            target.html = item.html || '';
            if (item.path) target.path = item.path;
          }
          continue;
        }
        if (item.kind !== 'send' || !item.chatId || !Array.isArray(item.openIds)) continue;
        const users = [];
        for (const openId of item.openIds) {
          const user = knownUser(openId);
          if (user && !users.some((found) => found.openId === user.openId)) users.push(user);
        }
        for (const user of users) {
          panes.push({
            id: nextId++,
            user,
            path: item.path || '/',
            sessionId: item.messageId,
            chatId: item.chatId,
            html: item.html || '',
            card: unwrapCard(item.card),
            pending: undefined,
            lane: 'chat-' + item.chatId,
            previewText: typeof item.previewText === 'string' ? item.previewText : '',
          });
        }
      }
      refresh();
    }

    function knownUser(openId) {
      const found = panes.find((item) => item.user.openId === openId && item.user.name && item.user.name !== openId);
      return found ? found.user : null;
    }

    function applyEphemeral(fromPane, data) {
      const removed = new Set(data.deletedEphemeral || []);
      for (let i = panes.length - 1; i >= 0; i--) {
        if (panes[i].ephemeralMessageId && removed.has(panes[i].ephemeralMessageId)) panes.splice(i, 1);
      }
      for (const item of data.ephemeral || []) {
        const existing = panes.find((itemPane) => itemPane.ephemeralMessageId === item.messageId);
        const user = knownUser(item.openId) || {
          openId: item.openId,
          userId: '',
          unionId: '',
          name: item.openId,
          avatar: avatarUrl('私', '7b61ff'),
        };
        if (existing) {
          existing.user = user;
          existing.card = unwrapCard(item.card);
          existing.html = item.html || '';
          existing.path = item.path || existing.path;
          const img = board.querySelector('[data-id="' + existing.id + '"] img');
          const name = board.querySelector('[data-id="' + existing.id + '"] .name');
          const id = board.querySelector('[data-id="' + existing.id + '"] .id');
          if (img) img.src = user.avatar;
          if (name) name.textContent = user.name;
          if (id) id.textContent = user.openId;
          continue;
        }
        const roomKey = fromPane.room ? item.messageId + ':' + item.openId : undefined;
        panes.push({
          id: nextId++,
          user,
          path: item.path || fromPane.path,
          sessionId: fromPane.room ? item.messageId : fromPane.sessionId,
          chatId: item.chatId || fromPane.chatId,
          html: item.html || '',
          card: unwrapCard(item.card),
          pending: undefined,
          ephemeral: true,
          ephemeralMessageId: item.messageId,
          room: !!fromPane.room,
          roomKey,
        });
      }
      if ((data.ephemeral && data.ephemeral.length) || removed.size) refresh();
    }

    function formValues(form) {
      if (!form) return {};
      const out = {};
      new FormData(form).forEach((value, key) => {
        if (typeof value !== 'string') return;
        if (out[key] === undefined) out[key] = value;
        else if (Array.isArray(out[key])) out[key].push(value);
        else out[key] = [out[key], value];
      });
      return out;
    }

    function paneFrom(node) {
      const article = node.closest('.pane');
      if (!article) return undefined;
      return paneById(article.dataset.id);
    }

    board.addEventListener('click', (event) => {
      const close = event.target.closest('[data-close]');
      if (close && board.contains(close)) {
        const pane = paneFrom(close);
        const index = panes.indexOf(pane);
        if (index >= 0) panes.splice(index, 1);
        refresh();
        return;
      }
      const button = event.target.closest('button[data-feishu-action]');
      if (!button || !board.contains(button)) return;
      if (button.getAttribute('type') === 'submit') return;
      const raw = button.getAttribute('data-feishu-action');
      if (!raw) return;
      const pane = paneFrom(button);
      if (!pane) return;
      event.preventDefault();
      post(pane, JSON.parse(raw), formValues(button.form), button.getAttribute('data-feishu-tag'));
    });

    board.addEventListener('submit', (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || !board.contains(form)) return;
      event.preventDefault();
      const pane = paneFrom(form);
      if (!pane) return;
      const submitter = event.submitter || form.querySelector('button[type="submit"][data-feishu-action]');
      const raw = submitter && submitter.getAttribute('data-feishu-action');
      if (!raw) return;
      post(pane, JSON.parse(raw), formValues(form), 'button');
    });

    board.addEventListener('change', (event) => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || !board.contains(el) || el.tagName === 'BUTTON') return;
      const raw = el.getAttribute('data-feishu-action');
      if (!raw) return;
      const pane = paneFrom(el);
      if (!pane) return;
      post(pane, JSON.parse(raw), formValues(el.closest('form')), el.getAttribute('data-feishu-tag'));
    });

    document.querySelector('#go').addEventListener('click', () => openPath(pathInput.value || '/'));
    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') openPath(pathInput.value || '/');
    });
    document.querySelector('#add-user').addEventListener('click', () => {
      if (!embed) return;
      fetch('/_larklet/preview/room', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: roomId, action: 'add-user' }),
      });
    });

    if (embed) {
      const roomSource = new EventSource('/_larklet/preview/stream?room=' + encodeURIComponent(roomId));
      roomSource.onmessage = (event) => {
        try { applyRoom(JSON.parse(event.data)); } catch (error) {}
      };
    }

    if (!embed) openPath('/');
  </script>
</body>
</html>`;
}
