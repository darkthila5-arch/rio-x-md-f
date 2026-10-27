// Shared client code for /settings and /admin. Uses textContent only (never innerHTML).
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(kid));
    return e;
  };
  let toastTimer;
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = `show${bad ? ' bad' : ''}`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, 3500);
  }
  async function api(method, url, body) {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-rio': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(j.error || 'Something went wrong. Try again.'); e.status = r.status; throw e; }
    return j;
  }
  const flash = (el) => { el.classList.remove('saved'); void el.offsetWidth; el.classList.add('saved'); setTimeout(() => el.classList.remove('saved'), 1200); };
  const busy = (btn, fn) => async (...a) => { btn.disabled = true; try { return await fn(...a); } finally { btn.disabled = false; } };

  const SCHEMA = [
    { title: 'General', items: [
      { k: 'mode', type: 'select', label: 'Who can use the bot', hint: 'Private means only you.', options: [['public', 'Everyone (public)'], ['private', 'Only me (private)']] },
    ] },
    { title: 'Statuses', items: [
      { k: 'statusSeen', type: 'switch', label: 'View statuses automatically' },
      { k: 'statusReact', type: 'switch', label: 'React to new statuses', hint: 'Only statuses under 30 minutes old. Too much automatic reacting can look like spam to WhatsApp.' },
      { k: 'statusEmojis', type: 'text', label: 'Reaction emojis', hint: 'Separate with spaces. Leave empty to use the default list.', placeholder: '😍 🔥 ❤️' },
      { k: 'statusSave', type: 'switch', label: 'Save statuses to my chat' },
    ] },
    { title: 'View-once', items: [
      { k: 'viewOnce', type: 'switch', label: 'Copy view-once photos, videos and voice notes to my chat' },
    ] },
    { title: 'Calls', items: [
      { k: 'callReject', type: 'switch', label: 'Reject incoming calls and send a message' },
      { k: 'autoAnswer', type: 'switch', label: 'Reject calls and reply with my saved audio or video' },
      { k: 'callStream', type: 'switch', label: 'Answer calls and play my saved clip', hint: 'Turn it off here. To turn it on, send .callstream on in WhatsApp (one-time device link).' },
      { k: 'callLoop', type: 'switch', label: 'Repeat the clip until the caller hangs up' },
      { k: 'callMsg', type: 'textarea', label: 'Message sent to rejected callers', hint: 'Leave empty to use the default message.' },
    ] },
  ];

  function renderSettings(root, values, save) {
    root.replaceChildren();
    const send = async (patch) => { const res = await save(patch); if (res?.settings) Object.assign(values, res.settings); return res; };
    SCHEMA.forEach((group, gi) => {
      const card = h('section', { class: 'card flat' }, h('h2', { style: 'margin-top:14px' }, group.title));
      card.style.setProperty('--i', gi);
      for (const it of group.items) {
        const id = `f-${it.k}`;
        const txt = h('span', { class: 'txt' }, h('b', {}, it.label), it.hint && h('small', {}, it.hint));
        if (it.type === 'switch') {
          const box = h('input', { type: 'checkbox', role: 'switch', class: 'sw', id, 'aria-label': it.label });
          box.checked = !!values[it.k];
          box.addEventListener('change', async () => {
            box.disabled = true;
            try { await send({ [it.k]: box.checked }); toast('Saved'); flash(row); }
            catch (e) { box.checked = !box.checked; toast(e.message, true); }
            finally { box.disabled = false; }
          });
          const row = h('label', { class: 'row', for: id }, txt, box);
          card.append(row);
        } else if (it.type === 'select') {
          const sel = h('select', { id, 'aria-label': it.label }, it.options.map(([v, t]) => h('option', { value: v }, t)));
          sel.value = values[it.k];
          sel.addEventListener('change', async () => {
            const prev = values[it.k]; sel.disabled = true;
            try { await send({ [it.k]: sel.value }); toast('Saved'); flash(row); }
            catch (e) { sel.value = prev; toast(e.message, true); }
            finally { sel.disabled = false; }
          });
          const row = h('div', { class: 'stack' }, txt, h('div', { style: 'margin-top:8px' }, sel));
          card.append(row);
        } else {
          const field = it.type === 'textarea' ? h('textarea', { id, maxlength: 500, 'aria-label': it.label }) : h('input', { id, type: 'text', maxlength: 200, placeholder: it.placeholder || '', 'aria-label': it.label });
          field.value = values[it.k] || '';
          const btn = h('button', { class: 'btn', type: 'submit' }, 'Save');
          const form = h('form', {}, field, btn);
          form.addEventListener('submit', busy(btn, async (ev) => {
            ev.preventDefault();
            try { await send({ [it.k]: field.value }); toast('Saved'); flash(row); } catch (e) { toast(e.message, true); }
          }));
          const row = h('div', { class: 'stack' }, txt, form);
          card.append(row);
        }
      }
      root.append(card);
    });
  }

  async function login(url, fields, after) {
    const form = $('#loginForm'), err = $('#loginError'), btn = $('button[type=submit]', form);
    form.addEventListener('submit', busy(btn, async (ev) => {
      ev.preventDefault(); err.textContent = '';
      try { await api('POST', url, Object.fromEntries(fields.map((f) => [f, form.elements[f].value]))); form.elements.password.value = ''; await after(); }
      catch (e) { err.textContent = e.message; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
    }));
  }
  const uptime = (s) => { const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : `${m}m`; };

  /* ---------- /settings ---------- */
  async function settingsPage() {
    const show = async () => {
      try {
        const me = await api('GET', '/api/me');
        $('#login').hidden = true; $('#panel').hidden = false;
        $('#who').hidden = false; $('#who').textContent = `+${me.phone}`;
        $('#status').textContent = me.status === 'connected' ? 'Your bot is online. Changes apply right away.' : 'Your bot is reconnecting. Changes are saved and apply once it is back.';
        renderSettings($('#groups'), me.settings, (p) => api('PATCH', '/api/me/settings', p));
      } catch { $('#login').hidden = false; $('#panel').hidden = true; $('#who').hidden = true; }
    };
    const out = () => { $('#login').hidden = false; $('#panel').hidden = true; $('#who').hidden = true; };
    await login('/api/web/login', ['phone', 'password'], show);
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/web/logout').catch(() => {}); out(); });
    $('#newPass').addEventListener('click', busy($('#newPass'), async () => {
      if (!confirm('Send a new password to your WhatsApp chat? You will be logged out and the old password stops working.')) return;
      try { await api('POST', '/api/me/password'); out(); toast('New password sent to your WhatsApp chat.'); } catch (e) { toast(e.message, true); }
    }));
    $('#unlink').addEventListener('click', busy($('#unlink'), async () => {
      if (!confirm('Unlink your number? The bot logs out of your WhatsApp and your saved settings are deleted. You can link again later.')) return;
      try { await api('POST', '/api/me/unlink', { confirm: true }); out(); toast('Your number was unlinked.'); } catch (e) { toast(e.message, true); }
    }));
    show();
  }

  /* ---------- /admin ---------- */
  async function adminPage() {
    let current = null;
    let first = true;
    const stat = (label, value, i, count) => {
      const num = h('span', {}, count == null ? String(value) : '0');
      const box = h('div', { class: `stat${first ? ' enter' : ''}` }, h('b', {}, num, count == null ? '' : String(value).slice(String(count).length)), h('small', {}, label));
      box.style.setProperty('--i', i);
      if (count != null) {
        if (!first || count === 0) num.textContent = String(count);
        else { const t0 = performance.now(); const tick = (t) => { const k = Math.min(1, (t - t0 - 250) / 800); num.textContent = String(Math.round(Math.max(0, k) * count)); if (k < 1) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }
      }
      return box;
    };
    const refresh = async () => {
      try {
        const o = await api('GET', '/api/admin/overview');
        $('#login').hidden = true; $('#panel').hidden = false; $('#logout').hidden = false;
        const linked = o.sessions.filter((s) => s.linked).length;
        $('#stats').replaceChildren(stat('Linked numbers', `${linked} of ${o.maxSessions}`, 0, linked), stat('Online now', o.connected, 1, o.connected), stat('Storage', o.storage, 2), stat('Call service', o.callService ? 'Ready' : 'Not running', 3), stat('Uptime', uptime(o.uptimeSeconds), 4));
        first = false;
        const ul = $('#sessions'); ul.replaceChildren();
        if (!o.sessions.length) ul.append(h('li', { class: 'note' }, 'No numbers are linked yet.'));
        for (const s of o.sessions) {
          ul.append(h('li', {}, h('button', { type: 'button', 'aria-current': s.id === current ? 'true' : 'false', onclick: () => open(s.id) },
            h('span', {}, s.linked ? `+${s.phone}` : 'Pairing in progress'),
            h('span', {}, h('span', { class: `pill${s.status === 'connected' ? ' on' : ''}` }, s.status.replace(/_/g, ' ')), ' ', h('span', { class: 'pill' }, s.mode), s.linked && !s.webPassword ? ' ' : '', s.linked && !s.webPassword ? h('span', { class: 'pill' }, 'no web password') : ''))));
        }
        const log = $('#audit'); log.replaceChildren();
        if (!o.audit.length) log.append(h('li', {}, 'Nothing yet.'));
        for (const a of o.audit) log.append(h('li', {}, `${new Date(a.at).toLocaleString()}  ${a.action}${a.detail ? `: ${a.detail}` : ''}`));
      } catch { $('#login').hidden = false; $('#panel').hidden = true; $('#logout').hidden = true; }
    };
    const open = async (id) => {
      try {
        const d = await api('GET', `/api/admin/session/${id}`);
        current = id; $('#detail').hidden = false; $('#detailTitle').textContent = `+${d.phone}`;
        renderSettings($('#groups'), d.settings, (p) => api('PATCH', `/api/admin/session/${id}/settings`, p).then((r) => { refresh(); return r; }));
        refresh(); $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) { toast(e.message, true); refresh(); }
    };
    const act = (btn, path, ask, done, closes) => btn.addEventListener('click', busy(btn, async () => {
      if (!current || (ask && !confirm(ask))) return;
      try { await api('POST', `/api/admin/session/${current}/${path}`); toast(done); if (closes) { current = null; $('#detail').hidden = true; } refresh(); } catch (e) { toast(e.message, true); }
    }));
    act($('#restart'), 'restart', 'Restart this bot connection?', 'Restarting');
    act($('#resetPass'), 'password', 'Send a new web password to this number\'s own WhatsApp chat? Their old password stops working.', 'New password sent');
    act($('#remove'), 'delete', 'Unlink this number and delete its saved settings? This cannot be undone.', 'Session deleted', true);
    await login('/api/admin/login', ['user', 'password'], refresh);
    $('#logout').addEventListener('click', async () => { await api('POST', '/api/admin/logout').catch(() => {}); current = null; $('#detail').hidden = true; refresh(); });
    refresh(); setInterval(() => { if (!$('#panel').hidden) refresh(); }, 30000);
  }

  document.body.dataset.page === 'admin' ? adminPage() : settingsPage();
})();
