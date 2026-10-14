import { MEDIA, buildMap, close, getCur, open, setOnShow, show, type Media, type NoteComment } from './wall';

interface ApiPost {
  id: string;
  kind: 'comment' | 'ema';
  target: string;
  replyTo: string | null;
  by: string;
  body: string;
  status: 'pending' | 'published' | 'rejected';
  posted: string;
  mine: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function getSavedBy(): string {
  try { return localStorage.getItem('notes-by') || ''; } catch { return ''; }
}
function setSavedBy(val: string) {
  try { localStorage.setItem('notes-by', val); } catch {}
}
function getDraft(key: string): string {
  try { return localStorage.getItem(`notes-draft:${key}`) || ''; } catch { return ''; }
}
function setDraft(key: string, val: string) {
  try {
    if (val) localStorage.setItem(`notes-draft:${key}`, val);
    else localStorage.removeItem(`notes-draft:${key}`);
  } catch {}
}

function emaTilt(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const raw = (((h >>> 0) % 601) - 300) / 100;
  if (Math.abs(raw) < 0.35) return raw < 0 ? -0.6 : 0.6;
  return raw;
}

function updateCharCount(el: HTMLElement, text: string, max = 300) {
  const rem = max - text.length;
  el.textContent = `剩餘 ${rem} 字`;
  el.classList.toggle('over', rem < 0);
}

/** 重新同步牆上所有按鈕的 data-i 與 MEDIA 陣列順序 */
function reindexWall() {
  const byId = new Map<string, Media>();
  for (const m of MEDIA) byId.set(m.id, m);

  const ordered: Media[] = [];
  document.querySelectorAll<HTMLElement>('#wall .it-media').forEach((btn) => {
    const id = btn.dataset.exhibitId || btn.dataset.emaId;
    if (!id) return;
    const item = byId.get(id);
    if (!item) return;
    const idx = ordered.push(item) - 1;
    btn.dataset.i = String(idx);
  });

  if (ordered.length === MEDIA.length) {
    MEDIA.splice(0, MEDIA.length, ...ordered);
  }
}

/** 更新牆上展品或繪馬的小紙籤（留言數） */
function syncOfuda(m: Media) {
  const btn = document.querySelector<HTMLElement>(
    m.type === 'ema' ? `#wall .it-ema[data-ema-id="${m.id}"]` : `#wall .it-media[data-exhibit-id="${m.id}"]`,
  );
  if (!btn) return;
  const count = (m.comments ?? []).length;
  const container = m.type === 'ema' ? btn.querySelector<HTMLElement>('.ema-foot') : btn.querySelector<HTMLElement>('.cap');
  if (!container) return;
  let badge = container.querySelector<HTMLElement>('.ofuda');
  if (count > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'ofuda';
      if (m.type === 'ema') container.prepend(badge);
      else container.append(badge);
    }
    badge.setAttribute('aria-label', `${count} 則留言`);
    badge.textContent = `籤 ${count}`;
  } else if (badge) {
    badge.remove();
  }
}

/** 建立或更新牆上的繪馬 DOM 節點 */
function ensureEmaOnWall(m: Media) {
  let btn = document.querySelector<HTMLButtonElement>(`#wall .it-ema[data-ema-id="${m.id}"]`);
  const author = m.by || '無署名';
  if (!btn) {
    const dayEl = document.querySelector<HTMLElement>(`.day[data-date="${m.date}"]`);
    if (!dayEl) return;
    const cols = dayEl.querySelector<HTMLElement>('.cols');
    if (!cols) return;
    let rack = cols.querySelector<HTMLElement>('.col.ema-rack');
    if (!rack) {
      rack = document.createElement('div');
      rack.className = 'col ema-rack';
      rack.style.setProperty('--colw', '240px');
      rack.dataset.dynamic = 'true';
      const rail = document.createElement('div');
      rail.className = 'ema-rail';
      const railSpan = document.createElement('span');
      railSpan.textContent = '繪馬掛所';
      rail.append(railSpan);
      const list = document.createElement('div');
      list.className = 'ema-list';
      rack.append(rail, list);
      cols.append(rack);
    }
    const list = rack.querySelector<HTMLElement>('.ema-list')!;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'it it-media it-ema in-rack';
    btn.dataset.emaId = m.id;
    btn.style.setProperty('--tilt', `${m.tilt ?? emaTilt(m.id)}deg`);
    btn.setAttribute('aria-label', `查看繪馬（${author}）`);

    const frame = document.createElement('span');
    frame.className = 'ema-frame';
    const cord = document.createElement('span');
    cord.className = 'ema-cord';
    cord.setAttribute('aria-hidden', 'true');
    const board = document.createElement('span');
    board.className = 'ema-board';
    const hole = document.createElement('span');
    hole.className = 'ema-hole';
    hole.setAttribute('aria-hidden', 'true');
    const bodyEl = document.createElement('span');
    bodyEl.className = 'ema-body';
    bodyEl.textContent = m.note;
    const foot = document.createElement('span');
    foot.className = 'ema-foot';
    const byEl = document.createElement('span');
    byEl.className = 'ema-by';
    byEl.textContent = author;
    foot.append(byEl);
    board.append(hole, bodyEl, foot);
    frame.append(cord, board);
    btn.append(frame);
    list.append(btn);
  }

  btn.classList.toggle('is-pending', m.status === 'pending');
  btn.classList.toggle('is-rejected', m.status === 'rejected');
  const foot = btn.querySelector<HTMLElement>('.ema-foot');
  if (foot) {
    let stBadge = foot.querySelector<HTMLElement>('.st-badge');
    if (m.status === 'pending' || m.status === 'rejected') {
      if (!stBadge) {
        stBadge = document.createElement('em');
        foot.prepend(stBadge);
      }
      stBadge.className = `st-badge ${m.status}`;
      stBadge.textContent = m.status === 'pending' ? '待展出' : '未展出';
    } else if (stBadge) {
      stBadge.remove();
    }
  }
  syncOfuda(m);
}

/** 將 API 回傳的單筆投稿合併進 MEDIA 與 DOM（同編號不重複） */
function mergePost(p: ApiPost) {
  if (p.kind === 'ema') {
    let existing = MEDIA.find((m) => m.id === p.id);
    if (existing) {
      existing.status = p.status;
      existing.mine = p.mine;
      ensureEmaOnWall(existing);
    } else {
      const dayEl = document.querySelector<HTMLElement>(`.day[data-date="${p.target}"]`);
      const place = dayEl?.dataset.place || '';
      const newEma: Media = {
        id: p.id,
        type: 'ema',
        title: `繪馬 · ${p.by || '無署名'}`,
        by: p.by,
        place,
        note: p.body,
        date: p.target,
        time: null,
        posted: p.posted,
        tilt: emaTilt(p.id),
        src: '',
        poster: null,
        width: 0,
        height: 0,
        duration: null,
        source: null,
        status: p.status,
        mine: p.mine,
        comments: [],
      };
      MEDIA.push(newEma);
      ensureEmaOnWall(newEma);
      reindexWall();
    }
  } else {
    const target = MEDIA.find((m) => m.id === p.target);
    if (!target) return;
    if (!target.comments) target.comments = [];
    const existing = target.comments.find((c) => c.id === p.id);
    if (existing) {
      existing.status = p.status;
      existing.mine = p.mine;
    } else {
      target.comments.push({
        id: p.id,
        target: p.target,
        replyTo: p.replyTo,
        by: p.by,
        body: p.body,
        posted: p.posted,
        status: p.status,
        mine: p.mine,
      });
      target.comments.sort((a, b) => a.posted.localeCompare(b.posted) || a.id.localeCompare(b.id));
    }
    syncOfuda(target);
  }
}

/** 建立兩段式「撤回 → 確定撤回／取消」按鈕組 */
function createWithdrawControl(label: string, onConfirm: () => Promise<void>): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'withdraw-ctrl';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'btn-link btn-withdraw';
  trigger.textContent = label;

  const confirmBox = document.createElement('span');
  confirmBox.className = 'withdraw-confirm';
  confirmBox.hidden = true;

  const ask = document.createElement('span');
  ask.textContent = '確定撤回？';
  const yesBtn = document.createElement('button');
  yesBtn.type = 'button';
  yesBtn.className = 'btn-link danger btn-withdraw-confirm';
  yesBtn.textContent = '確定撤回';
  const noBtn = document.createElement('button');
  noBtn.type = 'button';
  noBtn.className = 'btn-link btn-withdraw-cancel';
  noBtn.textContent = '取消';

  trigger.onclick = (e) => {
    e.stopPropagation();
    trigger.hidden = true;
    confirmBox.hidden = false;
  };
  noBtn.onclick = (e) => {
    e.stopPropagation();
    confirmBox.hidden = true;
    trigger.hidden = false;
  };
  yesBtn.onclick = async (e) => {
    e.stopPropagation();
    yesBtn.disabled = true;
    await onConfirm();
  };

  confirmBox.append(ask, yesBtn, noBtn);
  wrap.append(trigger, confirmBox);
  return wrap;
}

async function withdrawPost(id: string, kind: 'comment' | 'ema', targetId?: string) {
  const errEl = $('lb-err');
  errEl.hidden = true;
  try {
    const res = await fetch(`/api/posts/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `撤回失敗（${res.status}）`);
    }
    if (kind === 'comment' && targetId) {
      const target = MEDIA.find((m) => m.id === targetId);
      if (target?.comments) {
        target.comments = target.comments.filter((c) => c.id !== id);
        syncOfuda(target);
      }
      show(getCur());
    } else if (kind === 'ema') {
      const btn = document.querySelector<HTMLElement>(`#wall .it-ema[data-ema-id="${id}"]`);
      const rack = btn?.closest<HTMLElement>('.col.ema-rack');
      btn?.remove();
      if (rack && rack.dataset.dynamic === 'true' && !rack.querySelector('.it-ema')) {
        rack.remove();
      }
      const idx = MEDIA.findIndex((m) => m.id === id);
      if (idx !== -1) MEDIA.splice(idx, 1);
      reindexWall();
      buildMap();
      close();
    }
  } catch (err) {
    errEl.textContent = err instanceof Error ? err.message : '撤回失敗，請檢查網路連線';
    errEl.hidden = false;
  }
}

/* 說明卡內的留言與回覆互動 */
let currentTargetId = '';
let activeReply: NoteComment | null = null;

const lbForm = $('lb-form') as HTMLFormElement;
const lbBy = $('lb-by') as HTMLInputElement;
const lbBody = $('lb-body') as HTMLTextAreaElement;
const lbCnt = $('lb-cnt');
const lbErr = $('lb-err');
const lbSubmit = $('lb-submit') as HTMLButtonElement;
const lbReplying = $('lb-replying');
const lbReplyingText = $('lb-replying-text');
const lbReplyCancel = $('lb-reply-cancel');
const lbEmaActions = $('lb-ema-actions');

function setReplyTo(c: NoteComment | null) {
  activeReply = c;
  if (c) {
    const flat = c.body.replace(/\s+/g, ' ').trim();
    const snippet = flat.slice(0, 20) + (flat.length > 20 ? '…' : '');
    lbReplyingText.textContent = `正在回覆 ${c.by || '無署名'}：${snippet}`;
    lbReplying.hidden = false;
    lbBody.focus();
  } else {
    lbReplying.hidden = true;
    lbReplyingText.textContent = '';
  }
}

lbReplyCancel.onclick = () => setReplyTo(null);

lbBy.addEventListener('input', () => setSavedBy(lbBy.value.trim()));
lbBody.addEventListener('input', () => {
  updateCharCount(lbCnt, lbBody.value);
  if (currentTargetId) setDraft(`comment:${currentTargetId}`, lbBody.value);
});

setOnShow((m) => {
  // 繪馬若為本人待展出，提供撤回按鈕
  lbEmaActions.replaceChildren();
  if (m.type === 'ema' && m.mine && m.status === 'pending') {
    lbEmaActions.hidden = false;
    lbEmaActions.append(
      createWithdrawControl('撤回這塊繪馬', () => withdrawPost(m.id, 'ema')),
    );
  } else {
    lbEmaActions.hidden = true;
  }

  // 為每則留言加上「回覆」與（本人待展出時）「撤回」按鈕
  const comments = m.comments ?? [];
  const byId = new Map(comments.map((c) => [c.id, c]));
  document.querySelectorAll<HTMLElement>('#lb-notes .lb-note').forEach((noteEl) => {
    const cid = noteEl.dataset.cid;
    if (!cid) return;
    const c = byId.get(cid);
    if (!c) return;
    const meta = noteEl.querySelector<HTMLElement>('.lb-note-meta');
    if (!meta) return;

    const act = document.createElement('span');
    act.className = 'lb-note-act';
    if (c.status !== 'rejected' && m.status !== 'rejected') {
      const replyBtn = document.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'btn-link btn-reply';
      replyBtn.textContent = '回覆';
      replyBtn.onclick = () => setReplyTo(c);
      act.append(replyBtn);
    }
    if (c.mine && c.status === 'pending') {
      act.append(createWithdrawControl('撤回', () => withdrawPost(c.id, 'comment', m.id)));
    }
    meta.append(act);
  });

  // 切換到不同展品/繪馬時，載入對應草稿與署名
  if (currentTargetId !== m.id) {
    currentTargetId = m.id;
    setReplyTo(null);
    lbErr.hidden = true;
    if (!lbBy.value) lbBy.value = getSavedBy();
    lbBody.value = getDraft(`comment:${m.id}`);
    updateCharCount(lbCnt, lbBody.value);
  }
  lbForm.hidden = m.status === 'rejected';
});

lbForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentTargetId) return;
  lbErr.hidden = true;

  const by = lbBy.value.trim();
  const body = lbBody.value.trim();
  if (by.length > 20) {
    lbErr.textContent = '署名最多 20 字';
    lbErr.hidden = false;
    return;
  }
  if (body.length < 1 || body.length > 300) {
    lbErr.textContent = '留言內文須為 1～300 字';
    lbErr.hidden = false;
    return;
  }

  lbSubmit.disabled = true;
  try {
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'comment',
        target: currentTargetId,
        replyTo: activeReply?.id ?? null,
        by,
        body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `送出失敗（${res.status}）`);
    }
    setSavedBy(by);
    setDraft(`comment:${currentTargetId}`, '');
    lbBody.value = '';
    updateCharCount(lbCnt, '');
    setReplyTo(null);

    mergePost(data.post as ApiPost);
    show(getCur());
    const newEl = document.getElementById(`lb-c-${data.post.id}`);
    newEl?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    lbErr.textContent = err instanceof Error ? err.message : '網路連線失敗，輸入內容已保留，請稍後再試';
    lbErr.hidden = false;
  } finally {
    lbSubmit.disabled = false;
  }
});

/* 掛一塊繪馬視窗 */
const emaModal = $('ema-modal');
const emaModalDay = $('ema-modal-day');
const emaForm = $('ema-form') as HTMLFormElement;
const emaBy = $('ema-by') as HTMLInputElement;
const emaBody = $('ema-body') as HTMLTextAreaElement;
const emaCnt = $('ema-cnt');
const emaErr = $('ema-err');
const emaSubmit = $('ema-submit') as HTMLButtonElement;
const emaPreviewBody = $('ema-preview-body');
const emaPreviewBy = $('ema-preview-by');

let activeEmaDay = '';
let lastEmaFocus: HTMLElement | null = null;

function syncEmaPreview() {
  const text = emaBody.value.trim();
  const by = emaBy.value.trim();
  emaPreviewBody.textContent = text || '（在右側輸入文字，即時預覽繪馬木牌）';
  emaPreviewBy.textContent = by || '無署名';
  updateCharCount(emaCnt, emaBody.value);
}

function openEmaModal(date: string, label: string, trigger: HTMLElement) {
  lastEmaFocus = trigger;
  activeEmaDay = date;
  emaModalDay.textContent = label;
  emaErr.hidden = true;
  emaBy.value = getSavedBy();
  emaBody.value = getDraft(`ema:${date}`);
  syncEmaPreview();
  emaModal.hidden = false;
  document.body.style.overflow = 'hidden';
  emaBody.focus();
}

function closeEmaModal() {
  emaModal.hidden = true;
  document.body.style.overflow = '';
  lastEmaFocus?.focus();
}

document.querySelectorAll<HTMLButtonElement>('.btn-add-ema').forEach((btn) => {
  btn.addEventListener('click', () => {
    openEmaModal(btn.dataset.day || '', btn.dataset.dayLabel || '', btn);
  });
});

emaBy.addEventListener('input', () => {
  setSavedBy(emaBy.value.trim());
  syncEmaPreview();
});
emaBody.addEventListener('input', () => {
  if (activeEmaDay) setDraft(`ema:${activeEmaDay}`, emaBody.value);
  syncEmaPreview();
});

$('ema-x').onclick = closeEmaModal;
$('ema-cancel').onclick = closeEmaModal;
emaModal.addEventListener('click', (e) => {
  if (e.target === emaModal) closeEmaModal();
});
addEventListener('keydown', (e) => {
  if (!emaModal.hidden && e.key === 'Escape') closeEmaModal();
});

emaForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeEmaDay) return;
  emaErr.hidden = true;

  const by = emaBy.value.trim();
  const body = emaBody.value.trim();
  if (by.length > 20) {
    emaErr.textContent = '署名最多 20 字';
    emaErr.hidden = false;
    return;
  }
  if (body.length < 1 || body.length > 300) {
    emaErr.textContent = '繪馬內文須為 1～300 字';
    emaErr.hidden = false;
    return;
  }

  emaSubmit.disabled = true;
  try {
    const res = await fetch('/api/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'ema',
        target: activeEmaDay,
        by,
        body,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `送出失敗（${res.status}）`);
    }
    setSavedBy(by);
    setDraft(`ema:${activeEmaDay}`, '');
    emaBody.value = '';
    mergePost(data.post as ApiPost);
    buildMap();
    closeEmaModal();

    const idx = MEDIA.findIndex((m) => m.id === data.post.id);
    if (idx !== -1) open(idx);
  } catch (err) {
    emaErr.textContent = err instanceof Error ? err.message : '網路連線失敗，輸入內容已保留，請稍後再試';
    emaErr.hidden = false;
  } finally {
    emaSubmit.disabled = false;
  }
});

/* 初始化：載入目前登入者與待展出投稿 */
async function initEditPage() {
  const whoEl = $('edit-who');
  try {
    const [meRes, postsRes] = await Promise.all([fetch('/api/me'), fetch('/api/posts')]);
    if (!meRes.ok) {
      const d = await meRes.json().catch(() => ({}));
      whoEl.textContent = d.error || `尚未登入（${meRes.status}）`;
      whoEl.classList.add('err');
      return;
    }
    const me = (await meRes.json()) as { email: string };
    whoEl.textContent = `目前登入：${me.email}`;

    if (postsRes.ok) {
      const { posts } = (await postsRes.json()) as { posts: ApiPost[] };
      // 先放繪馬，再掛留言（因為留言可能掛在新繪馬底下）
      for (const p of posts.filter((x) => x.kind === 'ema')) mergePost(p);
      for (const p of posts.filter((x) => x.kind === 'comment')) mergePost(p);
      buildMap();
    }
  } catch {
    whoEl.textContent = '無法連線至投稿伺服器';
    whoEl.classList.add('err');
  }
}

initEditPage();
