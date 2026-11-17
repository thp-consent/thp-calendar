/* THP Ghana – colleague request form. The link carries the backend address and the request key:
 * request.html#u=<Apps Script URL>&k=<request key>   (copy it from THP Calendar → Work → Requests). */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const params = new URLSearchParams(location.hash.slice(1));
  const URL_ = params.get('u') || '', KEY = params.get('k') || '';
  const form = $('#rq');
  const state = { type: '', priority: 'Normal' };
  let files = [];
  if (!URL_ || !KEY) { $('#badLink').hidden = false; $('#send').disabled = true; }

  // remember who you are
  const me = JSON.parse(localStorage.getItem('rq-me') || '{}');
  ['fromName', 'fromEmail', 'fromPhone', 'team'].forEach((k) => { if (me[k]) form.elements[k].value = me[k]; });

  $$('.chips').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state[g.dataset.name] = b.dataset.v;
    g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    g.closest('.field').classList.remove('invalid'); g.closest('.field').querySelector('.err-msg')?.remove();
    if (g.dataset.name === 'type') $('#eventBox').hidden = !['Event coverage', 'Photos / video'].includes(state.type);
  }));

  const toast = (m) => { const t = $('#toast'); t.textContent = m; t.hidden = false; setTimeout(() => (t.hidden = true), 3000); };
  const toData = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  async function shrink(file) {
    if (!file.type.startsWith('image/') || file.size < 1.5 * 1048576) return file;
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas'); c.width = img.naturalWidth * s; c.height = img.naturalHeight * s;
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      return new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch { return file; } finally { URL.revokeObjectURL(url); }
  }
  $('#fileIn').addEventListener('change', async (e) => {
    for (const f of Array.from(e.target.files || [])) {
      if (files.length >= 3) { toast('Up to 3 files'); break; }
      const s = await shrink(f);
      if (s.size > 8 * 1048576) { toast(`${f.name} is over 8 MB – please share it by email or Drive instead`); continue; }
      files.push(s);
    }
    e.target.value = ''; renderFiles();
  });
  function renderFiles() {
    $('#fileList').innerHTML = files.map((f, i) => `<li><span>${f.name.replace(/[<>&]/g, '')} · ${Math.max(1, Math.round(f.size / 1024))} KB</span><button type="button" class="link-btn inline" data-rm="${i}">Remove</button></li>`).join('');
  }
  $('#fileList').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) { files.splice(+b.dataset.rm, 1); renderFiles(); } });

  function fail(el, msg) {
    const f = el.closest('.field'); f.classList.add('invalid');
    if (!f.querySelector('.err-msg')) { const m = document.createElement('div'); m.className = 'err-msg'; m.textContent = msg; f.appendChild(m); }
    return false;
  }
  form.addEventListener('input', (e) => { const f = e.target.closest('.field'); if (f) { f.classList.remove('invalid'); f.querySelector('.err-msg')?.remove(); } });

  $('#send').addEventListener('click', async () => {
    const v = (n) => String(form.elements[n].value || '').trim();
    let ok = true;
    if (!v('fromName')) ok = fail(form.elements.fromName, 'Please add your name') && ok;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v('fromEmail'))) ok = fail(form.elements.fromEmail, 'Please add a valid email') && ok;
    if (!state.type) ok = fail($('.chips[data-name="type"]'), 'Choose what you need') && ok;
    if (!v('title')) ok = fail(form.elements.title, 'Add a short title') && ok;
    if (!$('#eventBox').hidden && !v('eventDate')) ok = fail(form.elements.eventDate, 'When is the event?') && ok;
    if (!ok) { document.querySelector('.invalid').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    localStorage.setItem('rq-me', JSON.stringify({ fromName: v('fromName'), fromEmail: v('fromEmail'), fromPhone: v('fromPhone'), team: v('team') }));
    const request = { fromName: v('fromName'), fromEmail: v('fromEmail'), fromPhone: v('fromPhone'), team: v('team'), type: state.type, title: v('title'),
      details: v('details'), eventDate: $('#eventBox').hidden ? '' : v('eventDate'), eventTime: $('#eventBox').hidden ? '' : v('eventTime'),
      location: $('#eventBox').hidden ? '' : v('location'), neededBy: v('neededBy'), priority: state.priority };
    const btn = $('#send'); btn.disabled = true; btn.textContent = 'Sending…'; $('#msg').textContent = '';
    try {
      const payload = { kind: 'submitRequest', rkey: KEY, request, files: await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type || 'application/octet-stream', data: await toData(f) }))) };
      const res = await fetch(URL_, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow' });
      const j = await res.json();
      if (!j.ok) throw Object.assign(new Error(j.error || 'Not accepted'), { shown: true });
      form.hidden = true; $('#done').hidden = false; $('#ref').textContent = 'Reference ' + j.id; window.scrollTo(0, 0);
    } catch (e) {
      $('#msg').textContent = e.shown ? '⚠ ' + e.message : '⚠ Could not send – check your internet connection and tap Send again. Your answers are still here.';
    } finally { btn.disabled = false; btn.textContent = 'Send request'; }
  });
  $('#another').addEventListener('click', () => {
    ['title', 'details', 'eventDate', 'eventTime', 'location', 'neededBy'].forEach((k) => (form.elements[k].value = ''));
    files = []; renderFiles(); state.type = ''; $$('.chips[data-name="type"] button').forEach((b) => b.classList.remove('on')); $('#eventBox').hidden = true;
    form.hidden = false; $('#done').hidden = true; window.scrollTo(0, 0);
  });
})();
