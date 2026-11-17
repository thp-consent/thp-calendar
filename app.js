/* THP Ghana – Calendar (v1.0)
 * Social posting calendar + meetings/events (Google Calendar) + key dates + ideas + campaigns.
 * Google is the master copy: events live in Google Calendar; posts/ideas/campaigns/key dates in a Google Sheet;
 * photos, videos and voice notes in Google Drive. The app keeps a full copy on the device, works offline,
 * queues changes ("ops") and syncs about every minute.
 */
(() => {
  'use strict';
  const APP_VERSION = '1.1.0';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ============================================================ helpers */
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const ymd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const parseD = (s) => new Date(String(s).slice(0, 10) + 'T12:00:00');
  const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + n); return ymd(d); };
  const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);
  const fmtDay = (s, o = { weekday: 'short', day: 'numeric', month: 'short' }) => (s ? parseD(s).toLocaleDateString(undefined, o) : '');
  const timeOf = (s) => (String(s).length > 10 ? String(s).slice(11, 16) : '');
  function newId(prefix) {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const r = new Uint8Array(6); crypto.getRandomValues(r);
    return `${prefix}-${ymd().replace(/-/g, '')}-${Array.from(r, (b) => abc[b % abc.length]).join('')}`;
  }
  let toastT;
  function toast(m, ms = 2600) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
  const stPill = (s) => `<span class="status st-${String(s).replace(/\s+/g, '-')}">${esc(s)}</span>`;
  const splitTags = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const blobToDataURL = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

  /* ============================================================ settings */
  const settings = Object.assign({ url: '', key: '', device: '', postTime: '10:00', view: 'month' }, JSON.parse(localStorage.getItem('cal-settings') || '{}'));
  const saveSettings = () => localStorage.setItem('cal-settings', JSON.stringify(settings));

  /* ============================================================ IndexedDB */
  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('thp-calendar', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('cache');
          db.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
          db.createObjectStore('media');   // mid -> { blob, name, mime, size, fileId, url }
          db.createObjectStore('drafts');
        };
        r.onsuccess = () => { this._db = r.result; res(this._db); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(st, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(st, mode); const out = fn(t.objectStore(st));
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
        t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
    get: (st, k) => DB.tx(st, 'readonly', (s) => s.get(k)),
    put: (st, v, k) => DB.tx(st, 'readwrite', (s) => (k === undefined ? s.put(v) : s.put(v, k))),
    del: (st, k) => DB.tx(st, 'readwrite', (s) => s.delete(k)),
    all: (st) => DB.tx(st, 'readonly', (s) => s.getAll()),
  };
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  /* ============================================================ data: server snapshot + local changes */
  const TYPES = ['posts', 'ideas', 'campaigns', 'keydates', 'hashsets', 'events', 'requests', 'coverage'];
  const typeKey = { post: 'posts', idea: 'ideas', campaign: 'campaigns', keydate: 'keydates', hashset: 'hashsets', event: 'events', request: 'requests', coverage: 'coverage' };
  let S = null; // server snapshot
  const L = { posts: [], ideas: [], campaigns: [], keydates: [], hashsets: [], events: [], requests: [], coverage: [], thumbs: {} };
  let pendingOps = [];
  async function rebuild() {
    S = S || (await DB.get('cache', 'server')) || { posts: [], ideas: [], campaigns: [], keydates: [], hashsets: [], events: [], thumbs: {} };
    TYPES.forEach((t) => (L[t] = clone((S && S[t]) || [])));
    L.thumbs = { ...(S.thumbs || {}) };
    pendingOps = (await DB.all('ops')).sort((a, b) => a.seq - b.seq);
    pendingOps.forEach((o) => {
      const arr = L[typeKey[o.type]];
      const i = arr.findIndex((x) => x.id === (o.item ? o.item.id : o.id));
      if (o.action === 'delete') { if (i >= 0) arr.splice(i, 1); return; }
      const it = { ...clone(o.item), _pending: true };
      if (i >= 0) arr[i] = it; else arr.push(it);
    });
    // thumbnails for media added on this device
    for (const t of ['posts', 'ideas', 'coverage']) L[t].forEach((it) => (it.media || []).forEach((m) => { if (m.thumb) L.thumbs[m.mid] = m.thumb; }));
    const nNew = L.requests.filter((r) => r.status === 'New').length;
    $('#workDot').hidden = !nNew; $('#workDot').textContent = nNew;
    $('#tagList').innerHTML = [...new Set([...L.posts, ...L.ideas].flatMap((x) => x.tags || []))].map((t) => `<option value="${esc(t)}">`).join('');
  }
  const find = (type, id) => L[typeKey[type]].find((x) => x.id === id);

  async function queue(type, action, itemOrId) {
    const op = { type, action, ts: new Date().toISOString() };
    if (action === 'delete') op.id = itemOrId; else { op.item = { ...itemOrId, updatedAt: op.ts }; delete op.item._pending; }
    const id = op.item ? op.item.id : op.id;
    // coalesce with an older pending change to the same item
    const all = await DB.all('ops');
    for (const o of all) if (o.type === type && (o.item ? o.item.id : o.id) === id && !o.sending) {
      if (action === 'upsert' && o.action === 'upsert') { o.item = op.item; o.ts = op.ts; o.error = ''; await DB.put('ops', o); await rebuild(); syncSoon(); return; }
      if (action === 'delete' && String(id).startsWith('local-')) { await DB.del('ops', o.seq); await rebuild(); return; } // never reached Google
    }
    await DB.put('ops', op);
    await rebuild(); syncSoon();
  }

  /* ============================================================ media (photos, videos, voice) */
  async function addMediaFiles(files) {
    const out = [];
    for (const f of files) {
      const mid = newId('M');
      const kind = f.type.startsWith('video') ? 'video' : f.type.startsWith('audio') ? 'audio' : 'image';
      let blob = f;
      if (kind === 'image' && f.size > 2.5 * 1048576) blob = await shrinkImage(f, 2400, 0.85); // keep quality, save data
      await DB.put('media', { blob, name: f.name || `${mid}.${kind === 'image' ? 'jpg' : 'webm'}`, mime: blob.type || f.type, size: blob.size }, mid);
      const thumb = kind === 'image' ? await imageThumb(blob) : kind === 'video' ? await videoThumb(blob) : '';
      out.push({ mid, kind, name: f.name || mid, mime: blob.type || f.type, size: blob.size, thumb });
    }
    return out;
  }
  async function shrinkImage(file, max, q) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImg(url);
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    } finally { URL.revokeObjectURL(url); }
  }
  const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  async function imageThumb(blob) {
    const url = URL.createObjectURL(blob);
    try { const img = await loadImg(url); return drawThumb(img, img.naturalWidth, img.naturalHeight); } catch { return ''; } finally { URL.revokeObjectURL(url); }
  }
  function drawThumb(src, w, h) {
    const S2 = 240, s = Math.max(S2 / w, S2 / h);
    const c = document.createElement('canvas'); c.width = S2; c.height = S2;
    c.getContext('2d').drawImage(src, (S2 - w * s) / 2, (S2 - h * s) / 2, w * s, h * s);
    return c.toDataURL('image/jpeg', 0.7);
  }
  function videoThumb(blob) {
    return new Promise((res) => {
      const url = URL.createObjectURL(blob); const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata'; v.src = url;
      const done = (t) => { URL.revokeObjectURL(url); res(t); };
      const timer = setTimeout(() => done(''), 6000);
      v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) / 3); };
      v.onseeked = () => { clearTimeout(timer); try { done(drawThumb(v, v.videoWidth, v.videoHeight)); } catch { done(''); } };
      v.onerror = () => { clearTimeout(timer); done(''); };
    });
  }
  const thumbFor = (m) => L.thumbs[m.mid] || m.thumb || '';
  function mediaStrip(media, removable) {
    return (media || []).map((m, i) => {
      const th = thumbFor(m);
      const inner = m.kind === 'audio' ? '<div class="vid" style="display:grid;place-items:center;color:#fff">🎙</div>'
        : th ? `<img src="${th}" alt="">` : '<div class="vid"></div>';
      return `<div class="m" data-mi="${i}">${inner}${m.kind === 'video' ? '<span class="badge-v">▶ video</span>' : ''}${!m.fileId ? '<span class="up">not uploaded</span>' : ''}${removable ? `<button type="button" class="x" data-rmmedia="${i}">✕</button>` : ''}</div>`;
    }).join('');
  }

  /* ---- uploading media to Google Drive ---- */
  let uploadNote = '';
  async function ensureUploaded(m, folder) {
    if (m.fileId) return m;
    const rec = await DB.get('media', m.mid);
    if (rec && rec.fileId) return { ...m, fileId: rec.fileId, url: rec.url };
    if (!rec) throw Object.assign(new Error('A photo/video is missing on this device'), { fatal: true });
    let res;
    try {
      res = await resumableUpload(rec, m, folder);
    } catch (e) {
      if (rec.size > 30 * 1048576) throw e;
      res = await post({ kind: 'uploadSmall', name: rec.name, mime: rec.mime, folder, data: await blobToDataURL(rec.blob) }); // backup route
    }
    rec.fileId = res.fileId; rec.url = res.url; await DB.put('media', rec, m.mid);
    return { ...m, fileId: res.fileId, url: res.url };
  }
  async function resumableUpload(rec, m, folder) {
    const s = await post({ kind: 'startUpload', name: rec.name, mime: rec.mime, size: rec.size, folder, origin: location.origin });
    const CH = 4 * 1024 * 1024; let off = 0, last = null;
    while (off < rec.size) {
      const end = Math.min(off + CH, rec.size);
      uploadNote = `Uploading ${m.kind} ${fmtSize(end)} of ${fmtSize(rec.size)}…`; setSyncInfo();
      const r = await fetch(s.uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${off}-${end - 1}/${rec.size}` }, body: rec.blob.slice(off, end) });
      if (r.status === 308 || r.ok) { off = end; last = r; } else throw new Error('Upload failed (' + r.status + ')');
    }
    uploadNote = '';
    const j = await last.json();
    return { fileId: j.id, url: `https://drive.google.com/file/d/${j.id}/view` };
  }

  /* ============================================================ sync */
  let syncing = false, syncTimer, lastSync = '', syncErr = '';
  const syncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(syncAll, 800); };
  async function post(body) {
    const ctrl = new AbortController(); const tm = setTimeout(() => ctrl.abort(), 300000);
    try {
      const res = await fetch(settings.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ key: settings.key, ...body }), signal: ctrl.signal, redirect: 'follow' });
      const txt = await res.text(); let j;
      try { j = JSON.parse(txt); } catch { throw new Error('Unexpected reply from Google – check the upload link'); }
      if (!j.ok) throw Object.assign(new Error(j.error || 'Refused'), { fatal: true });
      return j;
    } finally { clearTimeout(tm); }
  }
  async function syncAll() {
    if (syncing) return;
    if (!settings.url || !settings.key) { syncErr = 'Add the upload link and key in More → Settings.'; setSyncInfo(); return; }
    if (!navigator.onLine) { setSyncInfo(); return; }
    syncing = true; syncErr = ''; setSyncInfo(); $('#btnSyncTop').classList.add('spin');
    try {
      for (const o of await DB.all('ops')) if (o.sending) { o.sending = false; await DB.put('ops', o); } // leftovers from an interrupted sync
      const ops = (await DB.all('ops')).sort((a, b) => a.seq - b.seq).filter((o) => !o.error);
      for (const o0 of ops) {
        const o = await DB.get('ops', o0.seq); // re-read: it may have been updated while earlier items were sending
        if (!o || o.error) continue;
        o.sending = true; await DB.put('ops', o);
        // upload any photos / videos / voice notes first
        if (o.item && o.item.media && o.item.media.some((m) => !m.fileId)) {
          const folder = o.type === 'idea' ? 'Ideas' : o.type === 'coverage' ? 'Coverage' : 'Posts';
          const media = [];
          for (const m of o.item.media) media.push(await ensureUploaded(m, folder));
          o.item.media = media; await DB.put('ops', o);
        }
        const send = clone(o);
        try {
          const j = await post({ kind: 'ops', ops: [send] });
          const r = (j.results || [])[0] || {};
          if (!r.ok) { o.error = r.error || 'Not accepted'; o.sending = false; await DB.put('ops', o); continue; }
          await DB.del('ops', o.seq);
          // a new Google Calendar event: swap our temporary id for the real one in later ops
          if (o.type === 'event' && r.item && o.item && o.item.id !== r.item.id) {
            for (const later of await DB.all('ops')) if (later.type === 'event' && (later.item ? later.item.id : later.id) === o.item.id) {
              if (later.item) later.item.id = r.item.id; else later.id = r.item.id; await DB.put('ops', later);
            }
            for (const cv of L.coverage) if (cv.eventId === o.item.id) await queue('coverage', 'upsert', { ...cv, eventId: r.item.id });
          }
        } catch (e) { o.sending = false; if (e.fatal) o.error = e.message; await DB.put('ops', o); if (!e.fatal) throw e; }
      }
      await pull();
      lastSync = new Date().toISOString();
    } catch (e) {
      syncErr = e.name === 'AbortError' ? 'Timed out – will retry.' : e.message;
    } finally {
      syncing = false; uploadNote = ''; $('#btnSyncTop').classList.remove('spin');
      await rebuild(); render(); setSyncInfo();
    }
  }
  async function pull() {
    const u = new URL(settings.url);
    u.searchParams.set('action', 'sync'); u.searchParams.set('key', settings.key);
    u.searchParams.set('from', addDays(ymd(), -120)); u.searchParams.set('to', addDays(ymd(), 430));
    const j = await (await fetch(u, { redirect: 'follow' })).json();
    if (!j.ok) throw new Error(j.error || 'Could not read from Google');
    S = j.data; S.fetchedAt = new Date().toISOString();
    await DB.put('cache', S, 'server');
  }
  async function setSyncInfo() {
    const ops = await DB.all('ops').catch(() => []);
    const failed = ops.filter((o) => o.error);
    const n = $('#netStatus');
    n.className = 'net ' + (navigator.onLine ? 'on' : 'off');
    n.textContent = !navigator.onLine ? `Offline${ops.length ? ` · ${ops.length} change${ops.length > 1 ? 's' : ''} waiting` : ''}`
      : syncing ? (uploadNote || 'Syncing…') : ops.length - failed.length ? `${ops.length - failed.length} change(s) waiting` : 'Up to date';
    const info = $('#syncInfo');
    if (info) info.innerHTML = `${lastSync ? 'Last synced ' + new Date(lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. ' : ''}${ops.length ? ops.length + ' change(s) not yet in Google. ' : 'Everything is in Google. '}${syncErr ? '<br><b>' + esc(syncErr) + '</b>' : ''}
      ${failed.length ? `<br><b style="color:var(--danger)">${failed.length} change(s) were refused: ${esc(failed[0].error)}</b> <button class="link-btn inline" id="btnDiscard">Discard them</button>` : ''}
      ${S && S.calendars ? `<br>Meetings from <b>${esc(S.calendars.main)}</b> · post reminders in <b>${esc(S.calendars.posts)}</b>` : ''}`;
    $('#btnDiscard')?.addEventListener('click', async () => {
      if (!confirm('Discard the refused changes? They will be removed from this device.')) return;
      for (const o of failed) await DB.del('ops', o.seq);
      await rebuild(); render(); setSyncInfo();
    });
  }
  window.addEventListener('online', () => syncAll());
  window.addEventListener('offline', setSyncInfo);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); else saveDraft(); });
  setInterval(() => { if (document.visibilityState === 'visible' && navigator.onLine) syncAll(); }, 60000);
  $('#btnSyncTop').addEventListener('click', syncAll);

  /* ============================================================ navigation */
  const TABS = ['calendar', 'ideas', 'posts', 'work', 'more'];
  let stack = ['calendar'];
  const cur = () => stack[stack.length - 1];
  const TITLES = { calendar: 'Calendar', ideas: 'Ideas', posts: 'Posts', more: 'More', settings: 'Settings', 'post-view': 'Post', 'post-edit': 'Post', 'event-view': 'Event', 'event-edit': 'Event', 'idea-edit': 'Idea', 'campaign-view': 'Campaign', 'campaign-edit': 'Campaign', 'keydate-edit': 'Key date', 'hashset-edit': 'Hashtags', work: 'Work', 'request-view': 'Request', 'coverage-view': 'Coverage', 'coverage-edit': 'Coverage' };
  function go(screen, push = true) {
    if (TABS.includes(screen)) stack = [screen]; else if (push) stack.push(screen);
    $$('.screen').forEach((s) => (s.hidden = true));
    $('#screen-' + screen).hidden = false;
    $$('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tabGo === stack[0]));
    $('#btnBackTop').hidden = TABS.includes(screen);
    $('#topTitle').textContent = TITLES[screen] || 'Calendar';
    $('#fabMenu').hidden = true; $('#fab').classList.remove('open');
    document.body.classList.toggle('in-wizard', !!$('#screen-' + screen).classList.contains('editor'));
    window.scrollTo(0, 0);
    armTrap();
    render();
  }
  function back() {
    const s = cur();
    if ($('#screen-' + s).classList.contains('editor') && editorDirty && !confirm('Leave without saving?')) return;
    if ($('#screen-' + s).classList.contains('editor')) { editorDirty = false; clearDraft(); }
    if (stack.length > 1) { stack.pop(); go(cur(), false); } else if (s !== 'calendar') go('calendar');
  }
  $('#btnBackTop').addEventListener('click', back);
  $$('[data-tab-go]').forEach((b) => b.addEventListener('click', () => {
    if ($('#screen-' + cur()).classList.contains('editor') && editorDirty && !confirm('Leave without saving?')) return;
    editorDirty = false; clearDraft(); go(b.dataset.tabGo);
  }));
  let trapArmed = false;
  function armTrap() { if (!trapArmed) { history.pushState({ t: 1 }, ''); trapArmed = true; } }
  window.addEventListener('popstate', () => { trapArmed = false; armTrap(); back(); });

  $('#fab').addEventListener('click', () => { const m = $('#fabMenu'); m.hidden = !m.hidden; $('#fab').classList.toggle('open', !m.hidden); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-new]'); if (!b) return;
    const k = b.dataset.new;
    if (k === 'post') openPostEditor({ date: calSel >= ymd() ? calSel : '' });
    if (k === 'event') openEventEditor({ startDate: calSel });
    if (k === 'idea') { go('ideas'); setTimeout(() => $('#capText').focus(), 100); }
    if (k === 'campaign') openCampaignEditor({});
    if (k === 'keydate') openKeydateEditor({});
    if (k === 'hashset') openHashsetEditor({});
    if (k === 'coverage') openCoverageEditor({ date: calSel >= ymd() ? calSel : ymd() });
  });

  function render() {
    const s = cur();
    if (s === 'calendar') renderCalendar();
    if (s === 'ideas') renderIdeas();
    if (s === 'posts') renderPosts();
    if (s === 'more') renderMore();
    if (s === 'post-view') renderPostView();
    if (s === 'event-view') renderEventView();
    if (s === 'campaign-view') renderCampaignView();
    if (s === 'work') renderWork();
    if (s === 'request-view') renderRequestView();
    if (s === 'coverage-view') renderCoverageView();
  }

  /* ============================================================ chips (single & multi) */
  const chipState = {};
  function chipSet(form, name, v) {
    const st = (chipState[form.id] = chipState[form.id] || {});
    const g = form.querySelector(`.chips[data-name="${name}"]`); if (!g) return;
    const multi = g.hasAttribute('data-multi');
    st[name] = multi ? (Array.isArray(v) ? v : []) : (v || '');
    $$('button', g).forEach((b) => b.classList.toggle('on', multi ? st[name].includes(b.dataset.v) : b.dataset.v === st[name]));
  }
  const chipGet = (form, name) => (chipState[form.id] || {})[name];
  document.addEventListener('click', (e) => {
    const b = e.target.closest('form .chips button'); if (!b) return;
    const g = b.closest('.chips'), form = b.closest('form'), name = g.dataset.name;
    if (g.hasAttribute('data-multi')) { const c = chipGet(form, name) || []; chipSet(form, name, c.includes(b.dataset.v) ? c.filter((x) => x !== b.dataset.v) : [...c, b.dataset.v]); }
    else chipSet(form, name, b.dataset.v);
    form.dispatchEvent(new Event('chipchange')); editorDirty = true; saveDraftSoon();
  });

  /* ============================================================ CALENDAR */
  let calView = settings.view || 'month', calCursor = ymd(), calSel = ymd();
  const kinds = { event: true, post: true, key: true, work: true };
  function itemsOn(day) {
    const out = [];
    if (kinds.event) L.events.forEach((e) => {
      const s = String(e.start).slice(0, 10), en = String(e.end || e.start).slice(0, 10);
      const last = e.allDay ? addDays(en, -1) : en; // all-day ends are exclusive
      if (day >= s && day <= (last < s ? s : last)) out.push({ k: 'event', t: e.allDay ? '' : (day === s ? timeOf(e.start) : ''), it: e });
    });
    if (kinds.post) L.posts.forEach((p) => { if (p.date === day) out.push({ k: 'post', t: p.time || '', it: p }); });
    // multi-day key dates (e.g. 16 Days) show on their first day; a campaign banner covers the rest
    if (kinds.key) L.keydates.forEach((k) => { if (day === k.date) out.push({ k: 'key', t: '', it: k }); });
    if (kinds.work) {
      L.requests.forEach((r) => { if (['Accepted', 'In progress'].includes(r.status) && r.dueDate === day && !(r.coverageId && L.coverage.some((c) => c.id === r.coverageId && c.date === day))) out.push({ k: 'req', t: '', it: r }); });
      L.coverage.forEach((c) => { if (c.date === day) out.push({ k: 'cov', t: c.time || '', it: c }); });
    }
    return out.sort((a, b) => (a.k === 'key' ? -1 : b.k === 'key' ? 1 : (a.t || '00') .localeCompare(b.t || '00')));
  }
  const campaignsOn = (day) => L.campaigns.filter((c) => day >= c.start && day <= c.end);
  function itemHtml(x) {
    if (x.k === 'event') return `<div class="item t-event" data-ev="${esc(x.it.id)}"><span class="time">${x.t || 'all day'}</span><div class="main"><b>${esc(x.it.title)}</b><small>${esc(x.it.location || 'Meeting / event')}${x.it._pending ? ' · not synced' : ''}</small></div></div>`;
    if (x.k === 'post') {
      const p = x.it, m = (p.media || [])[0], th = m ? thumbFor(m) : '';
      return `<div class="item t-post" data-post="${esc(p.id)}"><span class="time">${x.t || ''}</span><div class="main"><b>📣 ${esc(p.title)}</b><small>${esc((p.platforms || []).join(', ') || 'No platform yet')}${p._pending ? ' · not synced' : ''}</small></div>${th ? `<img class="thumb" src="${th}" alt="">` : ''}${stPill(p.status)}</div>`;
    }
    if (x.k === 'req') return `<div class="item t-req" data-req="${esc(x.it.id)}"><span class="time">🎯</span><div class="main"><b>${esc(x.it.title)}</b><small>Request · ${esc(x.it.fromName)} · ${esc(x.it.status)}</small></div></div>`;
    if (x.k === 'cov') return `<div class="item t-cov" data-cov="${esc(x.it.id)}"><span class="time">${x.t || '🎥'}</span><div class="main"><b>🎥 ${esc(x.it.title)}</b><small>Coverage · ${covProgress(x.it)}${x.it.location ? ' · ' + esc(x.it.location) : ''}</small></div></div>`;
    const k = x.it; const n = daysBetween(ymd(), k.date);
    return `<div class="item t-key" data-key="${esc(k.id)}"><span class="time">⭐</span><div class="main"><b>${esc(k.name)}</b><small>${esc(k.category || '')}${k.endDate ? ' · until ' + fmtDay(k.endDate) : ''}</small></div>${n > 0 ? `<span class="countdown">in ${n} day${n > 1 ? 's' : ''}</span>` : ''}</div>`;
  }
  function dayBlock(day, items, showEmpty) {
    const camps = campaignsOn(day);
    const head = `<div class="agenda-day ${day === ymd() ? 'today' : ''}">${fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long' })}${day === ymd() ? '<small>Today</small>' : ''}</div>`;
    const cb = camps.map((c) => `<div class="camp-banner" style="background:${esc(c.color || '#8e44ad')}" data-camp="${esc(c.id)}">📢 ${esc(c.name)} · day ${daysBetween(c.start, day) + 1} of ${daysBetween(c.start, c.end) + 1}</div>`).join('');
    return head + cb + (items.length ? items.map(itemHtml).join('') : showEmpty ? `<div class="empty-note">Nothing planned. <button class="link-btn inline" data-new="post">+ Post</button> <button class="link-btn inline" data-new="event">+ Event</button></div>` : '');
  }
  function renderCalendar() {
    $$('#viewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === calView));
    $$('#kindToggles [data-k]').forEach((b) => b.classList.toggle('on', kinds[b.dataset.k]));
    $('#calGrid').hidden = calView !== 'month';
    $('#calHead').hidden = calView === 'agenda';
    if (calView === 'month') {
      const [y, m] = calCursor.slice(0, 7).split('-').map(Number);
      const first = new Date(y, m - 1, 1);
      $('#calTitle').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
      let h = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('');
      for (let i = 0; i < 42; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i); const k = ymd(d);
        if (i === 35 && d.getMonth() !== m - 1) break;
        const its = itemsOn(k); const camp = campaignsOn(k)[0];
        h += `<button class="day ${d.getMonth() !== m - 1 ? 'other' : ''} ${k === ymd() ? 'today' : ''} ${k === calSel ? 'sel' : ''}" data-day="${k}">${d.getDate()}
          <span class="dots">${its.slice(0, 5).map((x) => `<i class="${x.k === 'post' ? 'p-' + x.it.status : 'k-' + x.k}"></i>`).join('')}</span>
          ${camp ? `<span class="camp" style="background:${esc(camp.color || '#8e44ad')}"></span>` : ''}</button>`;
      }
      $('#calGrid').innerHTML = h;
      $('#calList').innerHTML = dayBlock(calSel, itemsOn(calSel), true);
    }
    if (calView === 'week') {
      const c = parseD(calCursor); const mon = new Date(c); mon.setDate(c.getDate() - ((c.getDay() + 6) % 7));
      const days = [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return ymd(d); });
      $('#calTitle').textContent = `${fmtDay(days[0], { day: 'numeric', month: 'short' })} – ${fmtDay(days[6], { day: 'numeric', month: 'short', year: 'numeric' })}`;
      $('#calList').innerHTML = days.map((d) => dayBlock(d, itemsOn(d), true)).join('');
    }
    if (calView === 'agenda') {
      let h = ''; const t = ymd();
      for (let i = 0; i < 120; i++) { const d = addDays(t, i); const its = itemsOn(d); if (its.length || i === 0) h += dayBlock(d, its, i === 0); }
      $('#calList').innerHTML = h || '<p class="empty-note">Nothing coming up.</p>';
    }
  }
  $('#viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; calView = b.dataset.v; settings.view = calView; saveSettings(); renderCalendar(); });
  $('#calGrid').addEventListener('click', (e) => { const d = e.target.closest('[data-day]'); if (!d) return; calSel = d.dataset.day; renderCalendar(); });
  $('#calPrev').addEventListener('click', () => { calCursor = calView === 'week' ? addDays(calCursor, -7) : ymd(new Date(parseD(calCursor).getFullYear(), parseD(calCursor).getMonth() - 1, 1)); renderCalendar(); });
  $('#calNext').addEventListener('click', () => { calCursor = calView === 'week' ? addDays(calCursor, 7) : ymd(new Date(parseD(calCursor).getFullYear(), parseD(calCursor).getMonth() + 1, 1)); renderCalendar(); });
  $('#kindToggles').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (!b) return; kinds[b.dataset.k] = !kinds[b.dataset.k]; renderCalendar(); });
  $('#btnToday').addEventListener('click', () => { calCursor = calSel = ymd(); renderCalendar(); });
  document.addEventListener('click', (e) => {
    const p = e.target.closest('[data-post]'); if (p) return openPostView(p.dataset.post);
    const ev = e.target.closest('[data-ev]'); if (ev) return openEventView(ev.dataset.ev);
    const k = e.target.closest('[data-key]'); if (k) return openKeydateEditor(find('keydate', k.dataset.key) || {});
    const c = e.target.closest('[data-camp]'); if (c) return openCampaignView(c.dataset.camp);
    const rq = e.target.closest('[data-req]'); if (rq) return openRequestView(rq.dataset.req);
    const cv = e.target.closest('[data-cov]'); if (cv && !e.target.closest('[data-star],[data-shot],[data-eq],label')) return openCoverageView(cv.dataset.cov);
    const i = e.target.closest('[data-idea]'); if (i && !e.target.closest('button,a,audio')) return openIdeaEditor(find('idea', i.dataset.idea));
  });

  /* ============================================================ editors: shared draft handling */
  let editorDirty = false, editing = null;
  let draftT; const saveDraftSoon = () => { clearTimeout(draftT); draftT = setTimeout(saveDraft, 400); };
  async function saveDraft() {
    const s = cur(); const el = $('#screen-' + s);
    if (!el || !el.classList.contains('editor') || !editorDirty) return;
    if (s === 'post-edit') storeCaption();
    const fields = {}; Array.from(el.elements).forEach((x) => { if (x.name && x.type !== 'file') fields[x.name] = x.type === 'checkbox' ? x.checked : x.value; });
    await DB.put('drafts', { screen: s, editing, fields, chips: chipState[el.id] || {}, media: editMedia, custom: editCustom, capAll: s === 'post-edit' ? $('#peCaption').dataset.all : undefined, savedAt: Date.now() }, 'current').catch(() => {});
  }
  const clearDraft = () => DB.del('drafts', 'current').catch(() => {});
  document.addEventListener('input', (e) => { if (e.target.closest('form.editor')) { editorDirty = true; saveDraftSoon(); } });
  function fillForm(form, obj) { Array.from(form.elements).forEach((x) => { if (!x.name || x.type === 'file') return; if (x.type === 'checkbox') x.checked = !!obj[x.name]; else x.value = obj[x.name] ?? ''; }); }
  const fv = (form, n) => String(form.elements[n]?.value || '').trim();
  function fail(el, msg) { const f = el.closest('.field') || el; f.classList.add('invalid'); if (!f.querySelector('.err-msg')) { const m = document.createElement('div'); m.className = 'err-msg'; m.textContent = msg; f.appendChild(m); } f.scrollIntoView({ behavior: 'smooth', block: 'center' }); return false; }
  const clearErrs = (sc) => { $$('.invalid', sc).forEach((x) => x.classList.remove('invalid')); $$('.err-msg', sc).forEach((x) => x.remove()); };

  /* ---- media picking in editors ---- */
  let editMedia = []; // media of the item being edited
  document.addEventListener('change', async (e) => {
    const inp = e.target.closest('[data-media]'); if (!inp) return;
    const files = Array.from(inp.files || []); inp.value = ''; if (!files.length) return;
    const big = files.find((f) => f.size > 500 * 1048576);
    if (big) { toast('That video is over 500 MB – please trim it first'); return; }
    toast('Adding…', 1200);
    const added = await addMediaFiles(files);
    if (inp.dataset.media.startsWith('shot:')) {
      const i = +inp.dataset.media.split(':')[1]; added.forEach((m) => (m.shot = i));
      const c = find('coverage', viewingCov); const shots = clone(c.shots); if (shots[i]) shots[i].done = true;
      await saveCov({ media: [...(c.media || []), ...added], shots }); toast('Added – uploads to Drive on sync'); return;
    }
    if (inp.dataset.media === 'capture') { capMedia.push(...added); $('#capMedia').innerHTML = mediaStrip(capMedia, true); }
    else { editMedia.push(...added); renderEditMedia(); editorDirty = true; saveDraftSoon(); }
  });
  function renderEditMedia() { const t = { 'post-edit': '#peMedia', 'idea-edit': '#ieMedia' }[cur()]; if (t) $(t).innerHTML = mediaStrip(editMedia, true); }
  document.addEventListener('click', (e) => {
    const x = e.target.closest('[data-rmmedia]'); if (!x) return;
    const i = +x.dataset.rmmedia;
    if (x.closest('#capMedia')) { capMedia.splice(i, 1); $('#capMedia').innerHTML = mediaStrip(capMedia, true); return; }
    editMedia.splice(i, 1); renderEditMedia(); editorDirty = true; saveDraftSoon();
  });

  /* ============================================================ POSTS */
  const LIMITS = { X: 280, Instagram: 2200, LinkedIn: 3000, Facebook: 63206, TikTok: 2200, WhatsApp: 65536 };
  let postFilter = 'upcoming', editCustom = {}, capTab = 'all';
  function renderPosts() {
    $$('#postFilters button').forEach((b) => b.classList.toggle('on', b.dataset.f === postFilter));
    let list = L.posts.slice();
    const t = ymd();
    if (postFilter === 'upcoming') list = list.filter((p) => p.date && p.date >= t && p.status !== 'Posted');
    else if (postFilter === 'nodate') list = list.filter((p) => !p.date);
    else list = list.filter((p) => p.status === postFilter);
    list.sort((a, b) => (postFilter === 'Posted' ? -1 : 1) * String(a.date || '9999').localeCompare(String(b.date || '9999')));
    $('#postList').innerHTML = list.map((p) => `<div class="agenda-day" style="margin:10px 0 4px">${p.date ? fmtDay(p.date) : 'No date'}</div>${itemHtml({ k: 'post', t: p.time, it: p })}`).join('') || '<p class="empty-note">No posts here yet. Tap + to plan one.</p>';
  }
  $('#postFilters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; postFilter = b.dataset.f; renderPosts(); });

  function openPostEditor(init = {}, restore = null) {
    const form = $('#screen-post-edit');
    editing = { type: 'post', id: init.id || '', ideaId: init.ideaId || '' };
    const p = { status: init.date ? 'Scheduled' : 'Draft', time: init.date ? settings.postTime : '', platforms: ['Facebook', 'Instagram'], ...init };
    form.reset(); clearErrs(form);
    fillForm(form, { ...p, tags: (p.tags || []).join(', ') });
    $('#peCampaign').innerHTML = '<option value="">— none —</option>' + L.campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    form.elements.campaignId.value = p.campaignId || '';
    chipSet(form, 'status', p.status); chipSet(form, 'platforms', p.platforms || []);
    editMedia = clone(p.media || []); editCustom = clone(p.custom || {}); capTab = 'all';
    $('#peCaption').dataset.all = (restore && restore.capAll != null) ? restore.capAll : (p.caption || '');
    $('#peHeading').textContent = p.id ? 'Edit post' : 'New post';
    $('#peHashSets').innerHTML = L.hashsets.map((h) => `<button type="button" data-hs="${esc(h.id)}">+ ${esc(h.name)}</button>`).join('');
    if (restore) { fillForm(form, restore.fields); Object.entries(restore.chips || {}).forEach(([k, v]) => chipSet(form, k, v)); editMedia = restore.media || []; editCustom = restore.custom || {}; editorDirty = true; }
    else editorDirty = false;
    form.elements.caption.value = $('#peCaption').dataset.all;
    go('post-edit');
    renderEditMedia(); renderCapTabs(); updatePostedField();
  }
  function renderCapTabs() {
    const form = $('#screen-post-edit'); const plats = chipGet(form, 'platforms') || [];
    if (capTab !== 'all' && !plats.includes(capTab)) capTab = 'all';
    $('#peCapTabs').innerHTML = `<button type="button" data-ct="all" class="${capTab === 'all' ? 'on' : ''}">All platforms</button>` +
      plats.map((p) => `<button type="button" data-ct="${p}" class="${capTab === p ? 'on' : ''}">${p}${editCustom[p] ? ' ✎' : ''}</button>`).join('');
    $('#peCaption').value = capTab === 'all' ? (form.elements.caption.dataset.all ?? form.elements.caption.value) : (editCustom[capTab] ?? form.elements.caption.dataset.all ?? '');
    $('#peCaption').placeholder = capTab === 'all' ? 'Write the caption…' : `Caption just for ${capTab} (leave as is to use the main caption)`;
    updateCounter();
  }
  function updateCounter() {
    const form = $('#screen-post-edit'); const plats = chipGet(form, 'platforms') || [];
    const tags = fv(form, 'hashtags'); const cap = $('#peCaption').value;
    const len = (cap + (tags ? '\n\n' + tags : '')).length;
    const check = capTab === 'all' ? plats.filter((p) => !editCustom[p]) : [capTab];
    $('#peCount').innerHTML = `${len} characters` + check.filter((p) => LIMITS[p] < 10000).map((p) => ` · ${p} ${len > LIMITS[p] ? `<span class="over">${len - LIMITS[p]} over</span>` : `${LIMITS[p] - len} left`}`).join('');
  }
  $('#peCapTabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ct]'); if (!b) return;
    storeCaption(); capTab = b.dataset.ct; renderCapTabs();
  });
  function storeCaption() {
    const ta = $('#peCaption');
    if (capTab === 'all') ta.dataset.all = ta.value;
    else { const main = ta.dataset.all ?? ''; if (ta.value.trim() && ta.value !== main) editCustom[capTab] = ta.value; else delete editCustom[capTab]; }
  }
  $('#peCaption').addEventListener('input', () => { if (capTab === 'all') $('#peCaption').dataset.all = $('#peCaption').value; updateCounter(); });
  $('#screen-post-edit').addEventListener('input', (e) => { if (e.target.name === 'hashtags') updateCounter(); });
  $('#screen-post-edit').addEventListener('chipchange', () => { renderCapTabs(); updatePostedField(); });
  $('#peCampaign').addEventListener('change', () => {
    const c = find('campaign', $('#peCampaign').value); const f = $('#screen-post-edit');
    if (c && c.hashtags && !fv(f, 'hashtags').includes(c.hashtags)) f.elements.hashtags.value = (fv(f, 'hashtags') + ' ' + c.hashtags).trim();
    updateCounter();
  });
  $('#peHashSets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hs]'); if (!b) return;
    const h = find('hashset', b.dataset.hs); const f = $('#screen-post-edit');
    const cur2 = fv(f, 'hashtags').split(/\s+/).filter(Boolean);
    String(h.tags).split(/\s+/).filter(Boolean).forEach((t) => { if (!cur2.includes(t)) cur2.push(t); });
    f.elements.hashtags.value = cur2.join(' '); editorDirty = true; updateCounter();
  });
  function updatePostedField() { $('#pePostedWrap').hidden = chipGet($('#screen-post-edit'), 'status') !== 'Posted'; }
  $('#peSave').addEventListener('click', async () => {
    const f = $('#screen-post-edit'); clearErrs(f); storeCaption();
    if (!fv(f, 'title')) return fail(f.elements.title, 'Give the post a title');
    const status = chipGet(f, 'status') || 'Draft';
    if (status === 'Scheduled' && !fv(f, 'date')) return fail(f.elements.date, 'Pick a date to schedule it');
    const old = editing.id ? find('post', editing.id) : null;
    const p = {
      id: editing.id || newId('PO'), title: fv(f, 'title'), status, date: fv(f, 'date'), time: fv(f, 'time') || (fv(f, 'date') ? settings.postTime : ''),
      platforms: chipGet(f, 'platforms') || [], campaignId: fv(f, 'campaignId'), caption: $('#peCaption').dataset.all ?? fv(f, 'caption'),
      custom: editCustom, hashtags: fv(f, 'hashtags'), tags: splitTags(fv(f, 'tags')), media: editMedia, notes: fv(f, 'notes'),
      postedLink: fv(f, 'postedLink'), ideaId: editing.ideaId || (old && old.ideaId) || '', eventId: old ? old.eventId : '', createdAt: old ? old.createdAt : new Date().toISOString(),
    };
    await queue('post', 'upsert', p);
    if (editing.ideaId) { const idea = find('idea', editing.ideaId); if (idea) await queue('idea', 'upsert', { ...idea, status: 'Used', postId: p.id }); }
    editorDirty = false; clearDraft();
    toast(p.date ? `Saved – ${fmtDay(p.date)}${p.status === 'Scheduled' ? ' · reminder in Google Calendar' : ''}` : 'Saved');
    stack.pop(); viewing = p.id;
    if (cur() !== 'post-view') stack.push('post-view');
    go('post-view', false);
  });

  /* ---- post view: copy / share / posted ---- */
  let viewing = '', viewPlat = '';
  function openPostView(id) { viewing = id; viewPlat = ''; go('post-view'); }
  const captionFor = (p, pl) => { const c = (pl && p.custom && p.custom[pl]) || p.caption || ''; return c + (p.hashtags ? '\n\n' + p.hashtags : ''); };
  function renderPostView() {
    const p = find('post', viewing); if (!p) { back(); return; }
    const camp = p.campaignId ? find('campaign', p.campaignId) : null;
    $('#pvEyebrow').textContent = `Post${camp ? ' · ' + camp.name : ''}`;
    $('#pvTitle').textContent = p.title;
    $('#pvStatus').className = 'status st-' + p.status; $('#pvStatus').textContent = p.status + (p._pending ? ' · not synced yet' : '');
    $('#pvMeta').innerHTML = [
      ['When', p.date ? `${fmtDay(p.date, { weekday: 'long', day: 'numeric', month: 'long' })}${p.time ? ' · ' + p.time : ''}` : 'No date yet'],
      ['Platforms', (p.platforms || []).join(', ') || '—'], ['Tags', (p.tags || []).join(', ') || '—'],
      ...(p.notes ? [['Notes', p.notes]] : []),
      ...(p.postedLink ? [['Published', `<a href="${esc(p.postedLink)}" target="_blank" rel="noopener">View post</a>`]] : []),
    ].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${k === 'Published' ? v : esc(v)}</dd></div>`).join('');
    $('#pvMedia').innerHTML = mediaStrip(p.media, false) +
      (p.media || []).filter((m) => m.url).map((m, i) => '').join('');
    const plats = p.platforms || [];
    if (!viewPlat || !plats.includes(viewPlat)) viewPlat = plats[0] || '';
    $('#pvPlats').innerHTML = plats.map((pl) => `<button class="${pl === viewPlat ? 'on' : ''}" data-vp="${pl}">${pl}${p.custom && p.custom[pl] ? ' ✎' : ''}</button>`).join('');
    const cap = captionFor(p, viewPlat);
    $('#pvCaption').textContent = cap || '(no caption yet)';
    $('#pvCount').innerHTML = viewPlat && LIMITS[viewPlat] < 10000 ? `${cap.length} / ${LIMITS[viewPlat]}${cap.length > LIMITS[viewPlat] ? ' <span class="over">too long for ' + viewPlat + '</span>' : ''}` : `${cap.length} characters`;
    $('#pvOpen').textContent = viewPlat ? `Copy & open ${viewPlat}` : 'Copy & open app';
    $('#pvPosted').hidden = p.status === 'Posted';
  }
  $('#pvPlats').addEventListener('click', (e) => { const b = e.target.closest('[data-vp]'); if (!b) return; viewPlat = b.dataset.vp; renderPostView(); });
  $('#pvMedia').addEventListener('click', async (e) => {
    const m0 = e.target.closest('[data-mi]'); if (!m0) return;
    const p = find('post', viewing); const m = p.media[+m0.dataset.mi];
    const rec = await DB.get('media', m.mid);
    if (rec && rec.blob) { const u = URL.createObjectURL(rec.blob); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 60000); }
    else if (m.url) window.open(m.url, '_blank');
  });
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; }
    catch { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; }
  }
  $('#pvCopy').addEventListener('click', async () => { const p = find('post', viewing); if (await copyText(captionFor(p, viewPlat))) toast('Caption copied'); });
  const OPEN_URL = {
    Facebook: () => 'https://www.facebook.com/', Instagram: () => 'https://www.instagram.com/', LinkedIn: () => 'https://www.linkedin.com/feed/',
    X: (t) => 'https://x.com/intent/post?text=' + encodeURIComponent(t), WhatsApp: (t) => 'https://wa.me/?text=' + encodeURIComponent(t), TikTok: () => 'https://www.tiktok.com/upload',
  };
  $('#pvOpen').addEventListener('click', async () => {
    const p = find('post', viewing); const t = captionFor(p, viewPlat);
    await copyText(t); toast('Caption copied – paste it in the post');
    const fn = OPEN_URL[viewPlat]; if (fn) window.open(fn(t), '_blank');
  });
  $('#pvShare').addEventListener('click', async () => {
    const p = find('post', viewing); const text = captionFor(p, viewPlat);
    const files = []; const missing = [];
    for (const m of p.media || []) {
      const rec = await DB.get('media', m.mid);
      if (rec && rec.blob) files.push(new File([rec.blob], rec.name, { type: rec.mime }));
      else missing.push(m);
    }
    if (missing.length && navigator.onLine) {
      toast('Fetching photos/videos from Drive…', 4000);
      for (const m of missing) {
        try {
          const u = new URL(settings.url); u.searchParams.set('action', 'file'); u.searchParams.set('key', settings.key); u.searchParams.set('id', m.fileId);
          const j = await (await fetch(u, { redirect: 'follow' })).json();
          if (j.ok) { const b = await (await fetch(j.data)).blob(); await DB.put('media', { blob: b, name: m.name, mime: m.mime, size: b.size, fileId: m.fileId, url: m.url }, m.mid); files.push(new File([b], m.name, { type: m.mime })); }
          else toast(j.error || 'Could not fetch a file', 4000);
        } catch { toast('Could not fetch a file from Drive', 4000); }
      }
    }
    await copyText(text);
    const data = { text, title: p.title };
    if (files.length && navigator.canShare && navigator.canShare({ files })) data.files = files;
    if (navigator.share) {
      try { await navigator.share(data); if (data.files) toast('Tip: caption is also copied – paste it if the app drops it'); }
      catch (e) { if (e.name !== 'AbortError') toast('Sharing failed: ' + e.message); }
    } else toast('Caption copied. Sharing files is not supported in this browser.');
  });
  $('#pvEdit').addEventListener('click', () => openPostEditor(find('post', viewing)));
  $('#pvPosted').addEventListener('click', async () => {
    const p = find('post', viewing);
    const link = prompt('Link to the published post (optional):', p.postedLink || '');
    if (link === null) return;
    await queue('post', 'upsert', { ...p, status: 'Posted', postedLink: link.trim(), date: p.date || ymd() });
    toast('Marked as posted ✓'); renderPostView();
  });
  $('#pvDelete').addEventListener('click', async () => {
    const p = find('post', viewing);
    if (!confirm(`Delete "${p.title}"? It is also removed from Google (the sheet row is marked deleted and its calendar reminder removed).`)) return;
    await queue('post', 'delete', p.id); toast('Deleted'); back();
  });

  /* ============================================================ EVENTS (Google Calendar) */
  let viewingEv = '';
  function openEventView(id) { viewingEv = id; go('event-view'); }
  function renderEventView() {
    const e = find('event', viewingEv); if (!e) { back(); return; }
    $('#evTitle').textContent = e.title;
    $('#evEyebrow').textContent = `Google Calendar${e._pending ? ' · not synced yet' : ''}${e.recurring ? ' · repeating event' : ''}`;
    const s = String(e.start), en = String(e.end || '');
    const when = e.allDay ? `${fmtDay(s, { weekday: 'long', day: 'numeric', month: 'long' })}${en && addDays(en.slice(0, 10), -1) > s.slice(0, 10) ? ' – ' + fmtDay(addDays(en.slice(0, 10), -1)) : ''} · all day`
      : `${fmtDay(s, { weekday: 'long', day: 'numeric', month: 'long' })} · ${timeOf(s)}–${timeOf(en)}`;
    $('#evMeta').innerHTML = [['When', when], ['Where', e.location || '—'], ...(e.guests ? [['Guests', e.guests]] : [])].map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${/^https?:\/\//.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v)}</dd></div>`).join('');
    $('#evDesc').textContent = e.description || 'No description.';
    $('#evDesc').hidden = !e.description;
    $('#evOpen').hidden = !e.url; if (e.url) $('#evOpen').href = e.url;
    $('#evEdit').hidden = $('#evDelete').hidden = !!e.recurring || !!e.readOnly;
  }
  $('#evPlan').addEventListener('click', () => { const e = find('event', viewingEv); openPostEditor({ title: e.title, date: String(e.start).slice(0, 10), status: 'Draft', tags: [] }); });
  $('#evEdit').addEventListener('click', () => {
    const e = find('event', viewingEv); const s = String(e.start), en = String(e.end || e.start);
    openEventEditor({ id: e.id, title: e.title, allDay: e.allDay, startDate: s.slice(0, 10), startTime: timeOf(s), endDate: e.allDay ? addDays(en.slice(0, 10), -1) : en.slice(0, 10), endTime: timeOf(en), location: e.location, description: e.description });
  });
  $('#evDelete').addEventListener('click', async () => {
    const e = find('event', viewingEv);
    if (!confirm(`Delete "${e.title}" from your Google Calendar?`)) return;
    await queue('event', 'delete', e.id); toast('Deleted'); back();
  });
  function openEventEditor(init = {}, restore = null) {
    const f = $('#screen-event-edit');
    editing = { type: 'event', id: init.id || '' };
    f.reset(); clearErrs(f);
    fillForm(f, { startTime: '09:00', endTime: '10:00', ...init, endDate: init.endDate || init.startDate || ymd(), startDate: init.startDate || ymd() });
    if (restore) fillForm(f, restore.fields);
    editorDirty = !!restore;
    $('#eeHeading').textContent = init.id ? 'Edit meeting / event' : 'New meeting / event';
    go('event-edit'); toggleTimed();
  }
  function toggleTimed() { const f = $('#screen-event-edit'); $$('[data-timed]', f).forEach((x) => (x.hidden = f.elements.allDay.checked)); }
  $('#screen-event-edit').elements.allDay.addEventListener('change', toggleTimed);
  $('#screen-event-edit').elements.startTime.addEventListener('change', () => {
    const f = $('#screen-event-edit'); const [h, m] = fv(f, 'startTime').split(':').map(Number);
    if (!isNaN(h)) f.elements.endTime.value = `${pad2(Math.min(23, h + 1))}:${pad2(m)}`;
  });
  $('#screen-event-edit').elements.startDate.addEventListener('change', () => { const f = $('#screen-event-edit'); if (fv(f, 'endDate') < fv(f, 'startDate')) f.elements.endDate.value = fv(f, 'startDate'); });
  $('#eeSave').addEventListener('click', async () => {
    const f = $('#screen-event-edit'); clearErrs(f);
    if (!fv(f, 'title')) return fail(f.elements.title, 'Add a title');
    if (!fv(f, 'startDate')) return fail(f.elements.startDate, 'Pick a date');
    const allDay = f.elements.allDay.checked;
    const endD = fv(f, 'endDate') || fv(f, 'startDate');
    const start = allDay ? fv(f, 'startDate') : `${fv(f, 'startDate')}T${fv(f, 'startTime') || '09:00'}`;
    const end = allDay ? addDays(endD, 1) : `${endD}T${fv(f, 'endTime') || '10:00'}`;
    if (!allDay && end <= start) return fail(f.elements.endTime, 'End must be after the start');
    const ev = { id: editing.id || 'local-' + newId('EV'), title: fv(f, 'title'), allDay, start, end, location: fv(f, 'location'), description: fv(f, 'description') };
    await queue('event', 'upsert', ev);
    editorDirty = false; clearDraft();
    toast(navigator.onLine ? 'Saved to Google Calendar' : 'Saved – goes to Google Calendar when online');
    calSel = ev.start.slice(0, 10); calCursor = calSel; stack.pop(); viewingEv = ev.id;
    if (cur() !== 'event-view') stack.push('event-view');
    go('event-view', false);
  });

  /* ============================================================ IDEAS */
  let capMedia = [], ideaTag = '';
  function renderIdeas() {
    const tags = [...new Set(L.ideas.filter((i) => i.status !== 'Archived').flatMap((i) => i.tags || []))];
    $('#ideaFilters').innerHTML = ['', ...tags, '__archived'].map((t) => `<button data-it="${esc(t)}" class="${t === ideaTag ? 'on' : ''}">${t === '' ? 'All open' : t === '__archived' ? 'Used & archived' : esc(t)}</button>`).join('');
    let list = L.ideas.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    list = ideaTag === '__archived' ? list.filter((i) => i.status !== 'Open') : list.filter((i) => i.status === 'Open' && (!ideaTag || (i.tags || []).includes(ideaTag)));
    $('#ideaList').innerHTML = list.map((i) => `<div class="idea-card" data-idea="${esc(i.id)}">
      <p>${esc(i.text)}</p>
      ${(i.media || []).filter((m) => m.kind !== 'audio').length ? `<div class="media-strip">${mediaStrip((i.media || []).filter((m) => m.kind !== 'audio'), false)}</div>` : ''}
      ${(i.media || []).some((m) => m.kind === 'audio') ? `<div data-voice="${esc(i.id)}"></div>` : ''}
      ${i.link ? `<p><a href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.link.replace(/^https?:\/\//, '').slice(0, 50))}</a></p>` : ''}
      <div class="meta">${(i.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span>${esc(fmtDay(String(i.createdAt).slice(0, 10)))}${i._pending ? ' · not synced' : ''}</span>${i.status !== 'Open' ? stPill(i.status) : ''}</div>
      <div class="acts">${i.status === 'Open' ? `<button class="btn small primary" data-toPost="${esc(i.id)}">→ Make it a post</button>` : i.postId ? `<button class="btn small" data-post="${esc(i.postId)}">View post</button>` : ''}<button class="btn small" data-editIdea="${esc(i.id)}">Edit</button></div>
    </div>`).join('') || `<p class="empty-note">${ideaTag === '__archived' ? 'Nothing here.' : 'No ideas yet – jot one above.'}</p>`;
    $$('[data-voice]').forEach(async (el) => {
      const i = find('idea', el.dataset.voice); const a = (i.media || []).find((m) => m.kind === 'audio');
      const rec = await DB.get('media', a.mid);
      el.innerHTML = rec && rec.blob ? `<audio controls src="${URL.createObjectURL(rec.blob)}" style="width:100%"></audio>` : a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">🎙 Listen to voice note (Drive)</a>` : '🎙 Voice note';
    });
  }
  $('#ideaFilters').addEventListener('click', (e) => { const b = e.target.closest('[data-it]'); if (!b) return; ideaTag = b.dataset.it; renderIdeas(); });
  document.addEventListener('click', (e) => {
    const tp = e.target.closest('[data-toPost]'); if (tp) { const i = find('idea', tp.dataset.topost || tp.getAttribute('data-toPost')); ideaToPost(i); return; }
    const ed = e.target.closest('[data-editIdea]'); if (ed) openIdeaEditor(find('idea', ed.getAttribute('data-editIdea')));
  });
  function ideaToPost(i) {
    openPostEditor({ title: i.text.split('\n')[0].slice(0, 70), caption: i.text, tags: i.tags || [], media: (i.media || []).filter((m) => m.kind !== 'audio'), ideaId: i.id, status: 'Draft' });
    editorDirty = true;
  }
  // quick capture
  let recorder = null, recChunks = [], capVoice = null;
  $('#capRec').addEventListener('click', async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast('Voice recording is not supported here'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined); recChunks = [];
      recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recChunks, { type: recorder.mimeType || 'audio/webm' });
        const ext = /mp4/.test(blob.type) ? 'm4a' : 'webm';
        [capVoice] = await addMediaFiles([new File([blob], `Voice note ${ymd()}.${ext}`, { type: blob.type })]);
        $('#capAudio').src = URL.createObjectURL(blob); $('#capAudio').hidden = false;
        $('#capRec').classList.remove('on'); $('#capRec span').textContent = 'Re-record';
      };
      recorder.start(1000); $('#capRec').classList.add('on'); $('#capRec span').textContent = 'Stop';
    } catch { toast('Microphone permission is needed'); }
  });
  $('#capSave').addEventListener('click', async () => {
    const text = $('#capText').value.trim();
    if (!text && !capMedia.length && !capVoice) { toast('Write something first'); return; }
    if (recorder && recorder.state === 'recording') { toast('Stop the recording first'); return; }
    await queue('idea', 'upsert', { id: newId('ID'), text: text || '(voice/photo idea)', tags: splitTags($('#capTags').value), link: (text.match(/https?:\/\/\S+/) || [''])[0], media: [...capMedia, ...(capVoice ? [capVoice] : [])], status: 'Open', createdAt: new Date().toISOString() });
    $('#capText').value = ''; $('#capTags').value = ''; capMedia = []; capVoice = null; $('#capMedia').innerHTML = ''; $('#capAudio').hidden = true;
    $('#capRec span').textContent = 'Voice'; localStorage.removeItem('cal-capture');
    toast('Idea saved 💡'); renderIdeas();
  });
  ['capText', 'capTags'].forEach((id) => $('#' + id).addEventListener('input', () => localStorage.setItem('cal-capture', JSON.stringify({ text: $('#capText').value, tags: $('#capTags').value }))));
  function openIdeaEditor(i, restore = null) {
    if (!i) return;
    const f = $('#screen-idea-edit'); editing = { type: 'idea', id: i.id };
    f.reset(); fillForm(f, { ...i, tags: (i.tags || []).join(', ') }); chipSet(f, 'status', i.status || 'Open');
    editMedia = clone((i.media || []).filter((m) => m.kind !== 'audio'));
    editVoice = (i.media || []).filter((m) => m.kind === 'audio');
    if (restore) { fillForm(f, restore.fields); Object.entries(restore.chips || {}).forEach(([k, v]) => chipSet(f, k, v)); editMedia = restore.media || editMedia; }
    editorDirty = !!restore;
    $('#ieVoice').innerHTML = editVoice.length ? '<p class="hint">🎙 Has a voice note (kept).</p>' : '';
    go('idea-edit'); renderEditMedia();
  }
  let editVoice = [];
  $('#ieSave').addEventListener('click', async () => {
    const f = $('#screen-idea-edit'); const i = find('idea', editing.id);
    await queue('idea', 'upsert', { ...i, text: fv(f, 'text'), tags: splitTags(fv(f, 'tags')), link: fv(f, 'link'), status: chipGet(f, 'status') || 'Open', media: [...editMedia, ...editVoice] });
    editorDirty = false; clearDraft(); toast('Idea saved'); back();
  });
  $('#ieToPost').addEventListener('click', () => { const i = find('idea', editing.id); editorDirty = false; stack.pop(); ideaToPost(i); });
  $('#ieDelete').addEventListener('click', async () => {
    if (!confirm('Delete this idea? This cannot be undone.')) return;
    await queue('idea', 'delete', editing.id); editorDirty = false; clearDraft(); back();
  });

  /* ============================================================ CAMPAIGNS */
  let viewingCamp = '';
  function openCampaignView(id) { viewingCamp = id; go('campaign-view'); }
  function renderCampaignView() {
    const c = find('campaign', viewingCamp); if (!c) { back(); return; }
    $('#cvName').textContent = c.name;
    const total = daysBetween(c.start, c.end) + 1;
    $('#cvDates').textContent = `${fmtDay(c.start, { day: 'numeric', month: 'long' })} – ${fmtDay(c.end, { day: 'numeric', month: 'long', year: 'numeric' })} · ${total} days`;
    $('#cvHash').textContent = c.hashtags ? 'Hashtags: ' + c.hashtags : '';
    const posts = L.posts.filter((p) => p.campaignId === c.id || (p.date >= c.start && p.date <= c.end && (p.tags || []).some((t) => c.name.toLowerCase().includes(t.toLowerCase()))));
    let covered = 0, h = '';
    for (let i = 0; i < total; i++) {
      const d = addDays(c.start, i); const ps = posts.filter((p) => p.date === d);
      if (ps.length) covered++;
      const keys = L.keydates.filter((k) => k.date === d && !k.endDate);
      h += `<div class="planner-day"><div class="d">Day ${i + 1}<small>${fmtDay(d)}</small></div><div class="posts">
        ${keys.map((k) => `<div class="item t-key" data-key="${esc(k.id)}"><div class="main"><b>⭐ ${esc(k.name)}</b></div></div>`).join('')}
        ${ps.map((p) => `<div class="item t-post" data-post="${esc(p.id)}"><div class="main"><b>📣 ${esc(p.title)}</b><small>${esc(p.time || '')} · ${esc((p.platforms || []).join(', '))} · ${esc(p.status)}</small></div></div>`).join('') || `<button class="gap" data-plan="${d}">+ Plan a post</button>`}</div></div>`;
    }
    $('#cvPlanner').innerHTML = h;
    $('#cvBar').style.width = `${Math.round((covered / total) * 100)}%`;
    $('#cvProgress').textContent = `${covered} of ${total} days have a post planned`;
  }
  $('#cvPlanner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan]'); if (!b) return;
    const c = find('campaign', viewingCamp); const n = daysBetween(c.start, b.dataset.plan) + 1;
    openPostEditor({ title: `${c.name} – Day ${n}`, date: b.dataset.plan, campaignId: c.id, hashtags: c.hashtags || '', status: 'Draft', tags: [] });
  });
  $('#cvEdit').addEventListener('click', () => openCampaignEditor(find('campaign', viewingCamp)));
  $('#cvDelete').addEventListener('click', async () => {
    const c = find('campaign', viewingCamp);
    if (!confirm(`Delete the campaign "${c.name}"? Its posts are kept.`)) return;
    await queue('campaign', 'delete', c.id); back();
  });
  function openCampaignEditor(c, restore = null) {
    const f = $('#screen-campaign-edit'); editing = { type: 'campaign', id: c.id || '' };
    f.reset(); clearErrs(f); fillForm(f, { color: '#8e44ad', ...c }); if (restore) fillForm(f, restore.fields);
    editorDirty = !!restore; go('campaign-edit');
  }
  $('#ceSave').addEventListener('click', async () => {
    const f = $('#screen-campaign-edit'); clearErrs(f);
    if (!fv(f, 'name')) return fail(f.elements.name, 'Name the campaign');
    if (!fv(f, 'start') || !fv(f, 'end') || fv(f, 'end') < fv(f, 'start')) return fail(f.elements.end, 'Check the dates');
    const old = editing.id ? find('campaign', editing.id) : {};
    const c = { ...old, id: editing.id || newId('CA'), name: fv(f, 'name'), start: fv(f, 'start'), end: fv(f, 'end'), color: fv(f, 'color'), hashtags: fv(f, 'hashtags'), description: fv(f, 'description') };
    await queue('campaign', 'upsert', c); editorDirty = false; clearDraft();
    stack.pop(); viewingCamp = c.id; if (cur() !== 'campaign-view') stack.push('campaign-view'); go('campaign-view', false);
  });

  /* ============================================================ KEY DATES + HASHTAG SETS + MORE */
  let showAllKeys = false;
  function renderMore() {
    const t = ymd();
    const keys = L.keydates.filter((k) => (k.endDate || k.date) >= t).sort((a, b) => a.date.localeCompare(b.date));
    $('#keyList').innerHTML = (showAllKeys ? keys : keys.slice(0, 8)).map((k) => itemHtml({ k: 'key', it: k }).replace('<span class="time">⭐</span>', `<span class="time">${esc(fmtDay(k.date, { day: 'numeric', month: 'short' }))}</span>`)).join('') || '<p class="empty-note">No upcoming key dates.</p>';
    $('#btnAllKeys').textContent = showAllKeys ? 'Show fewer' : `Show all ${keys.length} upcoming key dates`;
    $('#campList').innerHTML = L.campaigns.slice().sort((a, b) => b.start.localeCompare(a.start)).map((c) => `<div class="item" data-camp="${esc(c.id)}" style="border-left-color:${esc(c.color || '#8e44ad')}"><div class="main"><b>${esc(c.name)}</b><small>${fmtDay(c.start, { day: 'numeric', month: 'short' })} – ${fmtDay(c.end, { day: 'numeric', month: 'short', year: 'numeric' })}</small></div></div>`).join('') || '<p class="empty-note">No campaigns yet.</p>';
    $('#hashList').innerHTML = L.hashsets.map((h) => `<div class="item" data-hsedit="${esc(h.id)}"><div class="main"><b>${esc(h.name)}</b><small>${esc(h.tags)}</small></div></div>`).join('') || '<p class="empty-note">No hashtag sets yet.</p>';
    setSyncInfo();
  }
  $('#btnAllKeys').addEventListener('click', () => { showAllKeys = !showAllKeys; renderMore(); });
  $('#hashList').addEventListener('click', (e) => { const b = e.target.closest('[data-hsedit]'); if (b) openHashsetEditor(find('hashset', b.dataset.hsedit)); });
  function openKeydateEditor(k, restore = null) {
    const f = $('#screen-keydate-edit'); editing = { type: 'keydate', id: k.id || '' };
    f.reset(); clearErrs(f); fillForm(f, k); chipSet(f, 'category', k.category || 'Other'); if (restore) fillForm(f, restore.fields);
    $('#keDelete').hidden = !k.id; $('#kePlan').hidden = !k.id; editorDirty = !!restore; go('keydate-edit');
  }
  $('#keSave').addEventListener('click', async () => {
    const f = $('#screen-keydate-edit'); clearErrs(f);
    if (!fv(f, 'name')) return fail(f.elements.name, 'Add a name'); if (!fv(f, 'date')) return fail(f.elements.date, 'Pick a date');
    await queue('keydate', 'upsert', { id: editing.id || newId('KD'), name: fv(f, 'name'), date: fv(f, 'date'), endDate: fv(f, 'endDate') > fv(f, 'date') ? fv(f, 'endDate') : '', category: chipGet(f, 'category') || 'Other', note: fv(f, 'note') });
    editorDirty = false; clearDraft(); toast('Key date saved'); back();
  });
  $('#kePlan').addEventListener('click', () => { const k = find('keydate', editing.id); editorDirty = false; stack.pop(); openPostEditor({ title: k.name, date: k.date, tags: [k.name], status: 'Draft' }); });
  $('#keDelete').addEventListener('click', async () => { if (!confirm('Delete this key date?')) return; await queue('keydate', 'delete', editing.id); editorDirty = false; clearDraft(); back(); });
  function openHashsetEditor(h, restore = null) {
    const f = $('#screen-hashset-edit'); editing = { type: 'hashset', id: h.id || '' };
    f.reset(); clearErrs(f); fillForm(f, h); if (restore) fillForm(f, restore.fields); $('#heDelete').hidden = !h.id; editorDirty = !!restore; go('hashset-edit');
  }
  $('#heSave').addEventListener('click', async () => {
    const f = $('#screen-hashset-edit'); clearErrs(f);
    if (!fv(f, 'name')) return fail(f.elements.name, 'Add a name'); if (!fv(f, 'tags')) return fail(f.elements.tags, 'Add hashtags');
    const tags = fv(f, 'tags').split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith('#') ? t : '#' + t)).join(' ');
    await queue('hashset', 'upsert', { id: editing.id || newId('HS'), name: fv(f, 'name'), tags }); editorDirty = false; clearDraft(); back();
  });
  $('#heDelete').addEventListener('click', async () => { if (!confirm('Delete this hashtag set?')) return; await queue('hashset', 'delete', editing.id); editorDirty = false; clearDraft(); back(); });

  /* ============================================================ WORK: comms requests + event coverage */
  const DEFAULT_SHOTS = ['Wide shot of the venue and crowd', 'THP / partner banners and branding', 'Each speaker at the front', 'Participants listening – close-ups of faces',
    'Hands-on activity / demonstration', 'Portraits of 2–3 participants (with consent)', 'Short video interview – one strong quote (30–60 s)',
    'B-roll video clips (10–20 s each)', 'Chiefs, officials and partners', 'Group photo at the end', 'Details: hands, tools, produce, materials'];
  const DEFAULT_EQUIP = ['Camera + charged batteries', 'Phone charged + power bank', 'Empty memory cards', 'Tripod / gimbal', 'Microphone (lapel)',
    'Consent app on tablet (or printed forms)', 'THP T-shirt / ID and banner', 'Notebook and pen'];
  let workSeg = 'requests', reqFilter = 'open';
  const REQ_RANK = { New: 0, Accepted: 1, 'In progress': 2, Done: 3, Declined: 4 };
  const formLink = () => (S && S.requestKey && settings.url
    ? `${location.origin}${location.pathname.replace(/[^/]*$/, '')}request.html#u=${encodeURIComponent(settings.url)}&k=${S.requestKey}` : '');
  const covProgress = (c) => { const s = c.shots || []; return `${s.filter((x) => x.done).length}/${s.length} shots`; };

  function renderWork() {
    $$('#workSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === workSeg));
    $('#workRequests').hidden = workSeg !== 'requests'; $('#workCoverage').hidden = workSeg !== 'coverage';
    $('#reqNewCount').textContent = L.requests.filter((r) => r.status === 'New').length || '';
    $$('#reqFilters button').forEach((b) => b.classList.toggle('on', b.dataset.f === reqFilter));
    let list = L.requests.slice();
    list = reqFilter === 'open' ? list.filter((r) => ['New', 'Accepted', 'In progress'].includes(r.status)) : list.filter((r) => r.status === reqFilter);
    const dk = (r) => String(r.dueDate || r.eventDate || r.neededBy || '9999');
    list.sort((a, b) => (REQ_RANK[a.status] - REQ_RANK[b.status]) || ((b.priority === 'Urgent') - (a.priority === 'Urgent')) || dk(a).localeCompare(dk(b)));
    $('#reqList').innerHTML = list.map(reqCard).join('') || `<p class="empty-note">${reqFilter === 'open' ? 'No open requests 🎉' : 'Nothing here.'}</p>`;
    const t = ymd(); const cov = L.coverage.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const up = cov.filter((c) => c.date >= t), past = cov.filter((c) => c.date < t).reverse();
    $('#covList').innerHTML = (up.length ? '<div class="agenda-day">Upcoming</div>' + up.map(covCard).join('') : '<p class="empty-note">No upcoming coverage.</p>') +
      (past.length ? '<div class="agenda-day">Past</div>' + past.slice(0, 20).map(covCard).join('') : '');
    $('#btnCopyForm').disabled = $('#btnShareForm').disabled = !formLink();
  }
  function reqCard(r) {
    const when = r.dueDate ? 'Due ' + fmtDay(r.dueDate) : r.eventDate ? 'Event ' + fmtDay(r.eventDate) : r.neededBy ? 'Needed by ' + fmtDay(r.neededBy) : '';
    const open = ['New', 'Accepted', 'In progress'].includes(r.status);
    return `<div class="req-card ${r.priority === 'Urgent' && open ? 'urgent' : ''}" data-req="${esc(r.id)}"><b>${esc(r.title)}</b>
      <small>${esc(r.type)} · ${esc(r.fromName)}${r.team ? ' (' + esc(r.team) + ')' : ''}${r._pending ? ' · not synced' : ''}</small>
      <div class="row"><small>${esc(when)}</small><span>${r.priority === 'Urgent' && open ? '<span class="status st-Changes-requested">Urgent</span> ' : ''}${stPill(r.status)}</span></div></div>`;
  }
  function covCard(c) {
    return `<div class="item t-cov" data-cov="${esc(c.id)}"><span class="time">${esc(fmtDay(c.date, { day: 'numeric', month: 'short' }))}</span><div class="main"><b>🎥 ${esc(c.title)}</b>
      <small>${esc(c.location || '')}${c.location ? ' · ' : ''}${covProgress(c)}${c._pending ? ' · not synced' : ''}</small></div>${stPill(c.status || 'Planned')}</div>`;
  }
  $('#workSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; workSeg = b.dataset.v; renderWork(); });
  $('#reqFilters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; reqFilter = b.dataset.f; renderWork(); });
  $('#btnCopyForm').addEventListener('click', async () => { if (await copyText(formLink())) toast('Request form link copied'); });
  $('#btnShareForm').addEventListener('click', async () => {
    const url = formLink(); if (!url) return;
    if (navigator.share) { try { await navigator.share({ title: 'THP Ghana comms requests', text: 'Need event coverage, a post, a flyer or photos from the comms team? Send your request here:', url }); } catch (_) { } }
    else if (await copyText(url)) toast('Link copied');
  });
  $('#btnOpenForm').addEventListener('click', () => { const u = formLink(); if (u) window.open(u, '_blank'); else toast('Connect to Google first (sync once)'); });

  /* ---- request view ---- */
  let viewingReq = '';
  function openRequestView(id) { viewingReq = id; $('#rvAccept').hidden = true; go('request-view'); }
  function renderRequestView() {
    const r = find('request', viewingReq); if (!r) { back(); return; }
    $('#rvEyebrow').textContent = `${r.type} · ${r.id}`;
    $('#rvTitle').textContent = r.title;
    $('#rvStatus').className = 'status st-' + String(r.status).replace(/\s+/g, '-');
    $('#rvStatus').textContent = r.status + (r._pending ? ' · not synced yet' : '');
    $('#rvUrgent').hidden = r.priority !== 'Urgent';
    const rows = [['From', `${r.fromName}${r.team ? ' – ' + r.team : ''}`], ['Email', r.fromEmail], ['Phone', r.fromPhone],
      ['Received', r.createdAt ? new Date(r.createdAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''],
      ['Event', [r.eventDate && fmtDay(r.eventDate), r.eventTime, r.location].filter(Boolean).join(' · ')], ['Needed by', r.neededBy && fmtDay(r.neededBy)],
      ['My due date', r.dueDate && fmtDay(r.dueDate)], ['Message sent', r.replyMessage]].filter((x) => x[1]);
    const wa = (v) => String(v).replace(/\D/g, '').replace(/^0/, '233');
    $('#rvMeta').innerHTML = rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${k === 'Email' ? `<a href="mailto:${esc(v)}">${esc(v)}</a>`
      : k === 'Phone' ? `<a href="tel:${esc(v)}">${esc(v)}</a> · <a href="https://wa.me/${esc(wa(v))}" target="_blank" rel="noopener">WhatsApp</a>` : esc(v)}</dd></div>`).join('');
    $('#rvDetails').textContent = r.details || 'No details given.';
    $('#rvFiles').innerHTML = (r.files || []).length ? '<p><b>Attachments</b><br>' + r.files.map((f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener">📎 ${esc(f.name)}</a>`).join('<br>') + '</p>' : '';
    const links = [];
    if (r.coverageId && find('coverage', r.coverageId)) links.push(`<button class="btn" data-cov="${esc(r.coverageId)}">🎥 Open coverage plan</button>`);
    if (r.postId && find('post', r.postId)) links.push(`<button class="btn" data-post="${esc(r.postId)}">📣 Open draft post</button>`);
    $('#rvLinks').innerHTML = links.join('');
    const a = [];
    if (r.status === 'New') a.push('<button class="btn primary big" data-ra="accept">Accept…</button>', '<button class="btn danger" data-ra="decline">Decline…</button>');
    if (r.status === 'Accepted') a.push('<button class="btn" data-ra="progress">Mark as in progress</button>');
    if (['Accepted', 'In progress'].includes(r.status)) {
      if (!r.coverageId) a.push('<button class="btn" data-ra="cover">🎥 Create coverage plan</button>');
      if (!r.postId) a.push('<button class="btn" data-ra="post">📣 Create draft post</button>');
      a.push('<button class="btn approve big" data-ra="done">✓ Mark as done…</button>', '<button class="btn danger" data-ra="decline">Decline…</button>');
    }
    if (['Done', 'Declined'].includes(r.status)) a.push('<button class="btn" data-ra="reopen">Reopen</button>');
    $('#rvActions').innerHTML = a.join('');
    $('#rvActions').hidden = !$('#rvAccept').hidden;
    if (document.activeElement !== $('#rvNotes')) $('#rvNotes').value = r.notes || '';
  }
  async function saveReq(changes) { const r = find('request', viewingReq); await queue('request', 'upsert', { ...r, ...changes }); if (cur() === 'request-view') renderRequestView(); }
  $('#rvActions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ra]'); if (!b) return;
    const r = find('request', viewingReq); const act = b.dataset.ra;
    if (act === 'accept') {
      $('#raDue').value = r.eventDate || r.neededBy || addDays(ymd(), 3);
      $('#raCov').checked = ['Event coverage', 'Photos / video'].includes(r.type);
      $('#raPost').checked = ['Social media post', 'Event coverage'].includes(r.type);
      $('#raEvWrap').hidden = !r.eventDate; $('#raEv').checked = !!r.eventDate && ['Event coverage', 'Photos / video'].includes(r.type);
      $('#raMsg').value = ''; $('#rvAccept').hidden = false; $('#rvActions').hidden = true;
      $('#rvAccept').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (act === 'decline') {
      const m = prompt(`Reason (sent to ${r.fromName} by email):`); if (m === null) return;
      if (!m.trim()) { toast('Please give a short reason'); return; }
      await saveReq({ status: 'Declined', replyMessage: m.trim() }); toast('Declined – they get an email when synced');
    }
    if (act === 'progress') await saveReq({ status: 'In progress' });
    if (act === 'done') {
      const m = prompt(`Message for ${r.fromName} (optional – e.g. a link to the post or the files):`, ''); if (m === null) return;
      await saveReq({ status: 'Done', replyMessage: m.trim() }); toast(`Done ✓ – ${r.fromName} gets an email when synced`);
    }
    if (act === 'reopen') await saveReq({ status: 'In progress' });
    if (act === 'cover') { const c = await createCoverageFromRequest(r, false); await saveReq({ coverageId: c.id }); openCoverageView(c.id); }
    if (act === 'post') { const p = await createPostFromRequest(r, r.dueDate || r.neededBy || ''); await saveReq({ postId: p.id }); openPostView(p.id); }
  });
  $('#raCancel').addEventListener('click', () => { $('#rvAccept').hidden = true; $('#rvActions').hidden = false; });
  $('#raConfirm').addEventListener('click', async () => {
    const r = find('request', viewingReq); const due = $('#raDue').value || '';
    const ch = { status: 'Accepted', dueDate: due, replyMessage: $('#raMsg').value.trim() };
    if ($('#raCov').checked && !r.coverageId) { const c = await createCoverageFromRequest(r, $('#raEv').checked); ch.coverageId = c.id; }
    else if ($('#raEv').checked && r.eventDate) await queue('event', 'upsert', reqEvent(r));
    if ($('#raPost').checked && !r.postId) { const p = await createPostFromRequest(r, due); ch.postId = p.id; }
    $('#rvAccept').hidden = true; $('#rvActions').hidden = false;
    await saveReq(ch);
    toast(`Accepted – ${r.fromName} gets an email when synced`);
  });
  $('#rvSaveNotes').addEventListener('click', async () => { await saveReq({ notes: $('#rvNotes').value }); toast('Notes saved'); });
  function reqEvent(r) {
    const t = r.eventTime || '09:00'; const [h, m] = t.split(':').map(Number);
    return { id: 'local-' + newId('EV'), title: '📸 ' + r.title, allDay: false, start: `${r.eventDate}T${t}`, end: `${r.eventDate}T${pad2(Math.min(23, h + 2))}:${pad2(m || 0)}`,
      location: r.location || '', description: `Comms coverage for ${r.fromName}${r.team ? ' (' + r.team + ')' : ''}.\n\n${r.details || ''}` };
  }
  async function createCoverageFromRequest(r, addEvent) {
    const c = { id: newId('CV'), title: r.title, date: r.eventDate || r.neededBy || ymd(), time: r.eventTime || '', location: r.location || '', requestId: r.id, eventId: '',
      contacts: [{ name: r.fromName, role: r.team || 'Requester', phone: r.fromPhone || '' }],
      shots: DEFAULT_SHOTS.map((t) => ({ text: t, done: false })), equipment: DEFAULT_EQUIP.map((t) => ({ text: t, done: false })),
      consentNeeded: '', consentCollected: '0', notes: r.details || '', status: 'Planned', highlights: '', media: [], postId: '' };
    if (addEvent && r.eventDate) { const ev = reqEvent(r); c.eventId = ev.id; await queue('event', 'upsert', ev); }
    await queue('coverage', 'upsert', c);
    return c;
  }
  async function createPostFromRequest(r, date) {
    const p = { id: newId('PO'), title: r.title, status: date ? 'Draft' : 'Idea', date: date || '', time: date ? settings.postTime : '', platforms: ['Facebook', 'Instagram'],
      campaignId: '', caption: r.details || '', custom: {}, hashtags: '', tags: [r.type], media: [], notes: `From request ${r.id} by ${r.fromName}`,
      postedLink: '', ideaId: '', eventId: '', createdAt: new Date().toISOString() };
    await queue('post', 'upsert', p);
    return p;
  }

  /* ---- coverage view ---- */
  let viewingCov = '';
  function openCoverageView(id) { viewingCov = id; go('coverage-view'); }
  function renderCoverageView() {
    const c = find('coverage', viewingCov); if (!c) { back(); return; }
    $('#cgTitle').textContent = c.title;
    $('#cgEyebrow').textContent = `Coverage plan · ${c.status || 'Planned'}${c._pending ? ' · not synced yet' : ''}`;
    $('#cgWhen').textContent = [fmtDay(c.date, { weekday: 'long', day: 'numeric', month: 'long' }), c.time, c.location].filter(Boolean).join(' · ');
    const links = []; const rq = c.requestId && find('request', c.requestId);
    if (rq) links.push(`<button class="btn small" data-req="${esc(c.requestId)}">🎯 Request from ${esc(rq.fromName)}</button>`);
    if (c.eventId && find('event', c.eventId)) links.push(`<button class="btn small" data-ev="${esc(c.eventId)}">📅 Calendar event</button>`);
    if (c.postId && find('post', c.postId)) links.push(`<button class="btn small" data-post="${esc(c.postId)}">📣 Draft post</button>`);
    $('#cgLinks').innerHTML = links.join('');
    $('#cgContacts').innerHTML = (c.contacts || []).map((p) => `<div class="contact"><div><b>${esc(p.name)}</b><small>${esc(p.role || '')}</small></div>${p.phone ? `<a href="tel:${esc(p.phone)}">📞 ${esc(p.phone)}</a>` : ''}</div>`).join('') || '<p class="empty-note">No contacts yet – add them with “Edit plan”.</p>';
    const eq = c.equipment || [];
    $('#cgEquip').innerHTML = eq.map((x, i) => `<div class="ck ${x.done ? 'done' : ''}"><span class="box" data-eq="${i}">${x.done ? '✓' : ''}</span><span class="txt">${esc(x.text)}</span></div>`).join('') || '<p class="empty-note">No equipment list.</p>';
    $('#cgEqCount').textContent = `${eq.filter((x) => x.done).length} of ${eq.length} packed`;
    $('#cgConsent').textContent = c.consentCollected || '0';
    $('#cgConsentOf').textContent = c.consentNeeded ? `collected of ~${c.consentNeeded} needed` : 'forms collected';
    const shots = c.shots || [];
    $('#cgShots').innerHTML = shots.map((x, i) => {
      const ms = (c.media || []).map((m, j) => ({ m, j })).filter((o) => o.m.shot === i);
      return `<div class="ck ${x.done ? 'done' : ''}"><span class="box" data-shot="${i}">${x.done ? '✓' : ''}</span><div class="txt">${esc(x.text)}
        ${ms.length ? `<div class="media-strip">${ms.map(({ m, j }) => `<div class="m" data-cm="${j}">${thumbFor(m) ? `<img src="${thumbFor(m)}" alt="">` : '<div class="vid"></div>'}${m.kind === 'video' ? '<span class="badge-v">▶</span>' : ''}<button type="button" class="star" data-star="${j}" aria-label="Best">${m.best ? '★' : '☆'}</button>${!m.fileId ? '<span class="up">not uploaded</span>' : ''}</div>`).join('')}</div>` : ''}</div>
        <label class="addm">+ 📷<input type="file" accept="image/*,video/*" multiple data-media="shot:${i}" hidden></label></div>`;
    }).join('') || '<p class="empty-note">No shot list.</p>';
    $('#cgShotCount').textContent = `${shots.filter((x) => x.done).length} of ${shots.length} done`;
    if (document.activeElement !== $('#cgHighlights')) $('#cgHighlights').value = c.highlights || '';
    $('#cgMakePost').textContent = c.postId && find('post', c.postId) ? 'Open the draft post' : 'Create draft post';
  }
  async function saveCov(changes, rerender = true) { const c = find('coverage', viewingCov); await queue('coverage', 'upsert', { ...c, ...changes }); if (rerender && cur() === 'coverage-view') renderCoverageView(); }
  $('#cgEquip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-eq]'); if (!b) return;
    const c = find('coverage', viewingCov); const eq = clone(c.equipment); eq[+b.dataset.eq].done = !eq[+b.dataset.eq].done; saveCov({ equipment: eq });
  });
  $('#cgShots').addEventListener('click', (e) => {
    const c = find('coverage', viewingCov);
    const b = e.target.closest('[data-shot]'); if (b) { const s2 = clone(c.shots); s2[+b.dataset.shot].done = !s2[+b.dataset.shot].done; saveCov({ shots: s2 }); return; }
    const st = e.target.closest('[data-star]'); if (st) { const m = clone(c.media); m[+st.dataset.star].best = !m[+st.dataset.star].best; saveCov({ media: m }); return; }
    const cm = e.target.closest('[data-cm]');
    if (cm) { const m = c.media[+cm.dataset.cm]; DB.get('media', m.mid).then((rec) => { if (rec && rec.blob) window.open(URL.createObjectURL(rec.blob), '_blank'); else if (m.url) window.open(m.url, '_blank'); }); }
  });
  $('#cgPlus').addEventListener('click', () => { const c = find('coverage', viewingCov); saveCov({ consentCollected: String((parseInt(c.consentCollected, 10) || 0) + 1) }); });
  $('#cgMinus').addEventListener('click', () => { const c = find('coverage', viewingCov); saveCov({ consentCollected: String(Math.max(0, (parseInt(c.consentCollected, 10) || 0) - 1)) }); });
  $('#cgSaveAfter').addEventListener('click', async () => { await saveCov({ highlights: $('#cgHighlights').value }); toast('Saved'); });
  $('#cgMakePost').addEventListener('click', async () => {
    const c = find('coverage', viewingCov);
    if (c.postId && find('post', c.postId)) { openPostView(c.postId); return; }
    const hl = $('#cgHighlights').value.trim();
    const best = (c.media || []).filter((m) => m.best);
    const media = (best.length ? best : (c.media || []).slice(0, 4)).map((m) => { const x = { ...m }; delete x.shot; delete x.best; return x; });
    const p = { id: newId('PO'), title: c.title, status: 'Draft', date: addDays(ymd(), 1), time: settings.postTime, platforms: ['Facebook', 'Instagram'], campaignId: '',
      caption: hl || `${c.title}${c.location ? ' in ' + c.location : ''}.`, custom: {}, hashtags: '', tags: ['Event'], media, notes: `From coverage plan ${c.id}`,
      postedLink: '', ideaId: '', eventId: '', createdAt: new Date().toISOString() };
    await queue('post', 'upsert', p);
    await saveCov({ highlights: hl, postId: p.id, status: 'Covered' }, false);
    toast('Draft post created for tomorrow – edit and schedule it'); openPostView(p.id);
  });
  $('#cgEdit').addEventListener('click', () => openCoverageEditor(find('coverage', viewingCov)));
  $('#cgDelete').addEventListener('click', async () => { if (!confirm('Delete this coverage plan? Photos/videos already uploaded stay in Drive.')) return; await queue('coverage', 'delete', viewingCov); back(); });
  $('#evCover').addEventListener('click', () => {
    const e = find('event', viewingEv);
    const existing = L.coverage.find((c) => c.eventId === e.id); if (existing) { openCoverageView(existing.id); return; }
    openCoverageEditor({ title: e.title, date: String(e.start).slice(0, 10), time: timeOf(e.start), location: e.location || '', eventId: e.id });
  });

  /* ---- coverage editor ---- */
  function openCoverageEditor(c = {}, restore = null) {
    const f = $('#screen-coverage-edit');
    editing = { type: 'coverage', id: c.id || '', extra: { eventId: c.eventId || '', requestId: c.requestId || '' } };
    f.reset(); clearErrs(f);
    fillForm(f, { ...c, date: c.date || ymd(),
      contacts: (c.contacts || []).map((p) => [p.name, p.role, p.phone].filter(Boolean).join(' – ')).join('\n'),
      shots: (c.shots || DEFAULT_SHOTS.map((t) => ({ text: t }))).map((x) => x.text).join('\n'),
      equipment: (c.equipment || DEFAULT_EQUIP.map((t) => ({ text: t }))).map((x) => x.text).join('\n') });
    f.elements.addEvent.checked = false; f.elements.addEvent.closest('label').hidden = !!c.eventId;
    if (restore) fillForm(f, restore.fields);
    $('#ceHeading').textContent = c.id ? 'Edit coverage plan' : 'New coverage plan';
    editorDirty = !!restore; go('coverage-edit');
  }
  $('#cgSave').addEventListener('click', async () => {
    const f = $('#screen-coverage-edit'); clearErrs(f);
    if (!fv(f, 'title')) return fail(f.elements.title, 'Add a title');
    if (!fv(f, 'date')) return fail(f.elements.date, 'Pick a date');
    const old = editing.id ? find('coverage', editing.id) : null;
    const keep = (lines, prev) => lines.split('\n').map((x) => x.trim()).filter(Boolean).map((text) => ({ text, done: !!(prev || []).find((x) => x.text === text && x.done) }));
    const contacts = fv(f, 'contacts').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const phone = (l.match(/\+?\d[\d\s]{6,}\d/) || [''])[0].trim();
      const parts = l.replace(phone, '').split(/\s+[–-]\s+|\s*[–-]\s*$/).map((x) => x.trim()).filter(Boolean);
      return { name: parts[0] || l, role: parts[1] || '', phone };
    });
    const c = { ...(old || {}), id: editing.id || newId('CV'), title: fv(f, 'title'), date: fv(f, 'date'), time: fv(f, 'time'), location: fv(f, 'location'), contacts,
      shots: keep(fv(f, 'shots'), old && old.shots), equipment: keep(fv(f, 'equipment'), old && old.equipment),
      consentNeeded: fv(f, 'consentNeeded'), consentCollected: old ? old.consentCollected : '0', notes: fv(f, 'notes'), status: old ? old.status : 'Planned',
      highlights: old ? old.highlights : '', media: old ? old.media || [] : [], postId: old ? old.postId : '',
      eventId: (old && old.eventId) || editing.extra.eventId || '', requestId: (old && old.requestId) || editing.extra.requestId || '' };
    // photos stay attached to the same shot even if the list was edited
    if (old && old.media && old.shots) c.media = old.media.map((m) => { if (m.shot == null) return m; const t = (old.shots[m.shot] || {}).text; const ni = c.shots.findIndex((x) => x.text === t); return { ...m, shot: ni >= 0 ? ni : null }; });
    if (f.elements.addEvent.checked && !c.eventId) {
      const t = c.time || '09:00'; const [h, m] = t.split(':').map(Number);
      const ev = { id: 'local-' + newId('EV'), title: '📸 ' + c.title, allDay: false, start: `${c.date}T${t}`, end: `${c.date}T${pad2(Math.min(23, h + 2))}:${pad2(m || 0)}`, location: c.location, description: 'Comms coverage – plan in THP Calendar.' };
      c.eventId = ev.id; await queue('event', 'upsert', ev);
    }
    await queue('coverage', 'upsert', c);
    editorDirty = false; clearDraft(); toast('Coverage plan saved');
    stack.pop(); viewingCov = c.id; if (cur() !== 'coverage-view') stack.push('coverage-view'); go('coverage-view', false);
  });

  /* ============================================================ SETTINGS */
  $('#btnSettings').addEventListener('click', () => {
    $('#setUrl').value = settings.url; $('#setKey').value = settings.key; $('#setDevice').value = settings.device; $('#setPostTime').value = settings.postTime;
    $('#testMsg').textContent = ''; go('settings');
  });
  const readSettings = () => { settings.url = $('#setUrl').value.trim(); settings.key = $('#setKey').value.trim(); settings.device = $('#setDevice').value.trim(); settings.postTime = $('#setPostTime').value || '10:00'; };
  $('#btnSaveSettings').addEventListener('click', () => { readSettings(); saveSettings(); toast('Settings saved'); go('more'); syncAll(); });
  $('#btnTest').addEventListener('click', async () => {
    readSettings(); const m = $('#testMsg'); m.textContent = 'Testing…';
    try {
      const u = new URL(settings.url); u.searchParams.set('action', 'ping'); u.searchParams.set('key', settings.key);
      const j = await (await fetch(u, { redirect: 'follow' })).json();
      m.textContent = j.ok && j.keyValid ? `✓ Connected · meetings from "${j.calendars.main}", post reminders in "${j.calendars.posts}"` : j.ok ? '✗ Connected, but the key is wrong.' : '✗ ' + (j.error || 'Failed');
    } catch { m.textContent = '✗ Could not reach the upload link.'; }
  });
  $('#btnSync').addEventListener('click', syncAll);

  /* ============================================================ BOOT */
  history.replaceState({ home: 1 }, '');
  (async () => {
    await rebuild();
    const cap = JSON.parse(localStorage.getItem('cal-capture') || 'null'); if (cap) { $('#capText').value = cap.text || ''; $('#capTags').value = cap.tags || ''; }
    const d = await DB.get('drafts', 'current').catch(() => null);
    go('calendar');
    if (d && d.screen) {
      const it = d.editing || {};
      const base = it.id ? find(it.type, it.id) || {} : {};
      if (d.screen === 'post-edit') { openPostEditor({ ...base, ideaId: it.ideaId }, d); }
      if (d.screen === 'event-edit') openEventEditor(base.id ? { id: base.id } : {}, d);
      if (d.screen === 'idea-edit' && base.id) openIdeaEditor(base, d);
      if (d.screen === 'campaign-edit') openCampaignEditor(base, d);
      if (d.screen === 'keydate-edit') openKeydateEditor(base, d);
      if (d.screen === 'hashset-edit') openHashsetEditor(base, d);
      if (d.screen === 'coverage-edit') openCoverageEditor({ ...base, ...(it.extra || {}) }, d);
      if (cur() !== 'calendar') toast('Continuing where you left off');
    }
    setSyncInfo();
    if (!settings.url) toast('Open More → Settings to connect to Google', 4000);
    syncAll();
  })();
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
