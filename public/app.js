(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const days = [[1, 'Isn'], [2, 'Sen'], [3, 'Sel'], [4, 'Rab'], [5, 'Kha'], [6, 'Jum'], [7, 'Sab']];
  const state = { csrf: '', data: null };
  const escapeText = (value) => String(value ?? '');
  const show = (selector, text) => { const el = $(selector); el.textContent = text; el.hidden = false; };
  const hide = (selector) => { $(selector).hidden = true; };
  const errorText = (error) => error?.message || 'Permintaan tidak berjaya. Cuba lagi.';

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (options.method && !['GET', 'HEAD'].includes(options.method)) headers['X-CSRF-Token'] = state.csrf;
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Permintaan gagal (${response.status})`);
    return payload;
  }

  function setAuthenticated(authenticated) {
    $('#login-view').hidden = authenticated;
    $('#app-view').hidden = !authenticated;
  }

  function value(form, name) { return new FormData(form).get(name) || ''; }
  function lines(text) { return String(text || '').split('\n').map((s) => s.trim()).filter(Boolean); }

  function buildDays() {
    const target = $('#active-days');
    target.replaceChildren(...days.map(([id, label]) => {
      const wrapper = document.createElement('label'); wrapper.className = 'day-pick';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = String(id); input.name = 'activeDays';
      const text = document.createElement('span'); text.textContent = label;
      wrapper.append(input, text); return wrapper;
    }));
  }

  function setFormValues(form, values) {
    for (const [key, val] of Object.entries(values)) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field instanceof RadioNodeList || (field.length && field[0]?.type === 'checkbox')) {
        const chosen = Array.isArray(val) ? val.map(String) : [];
        [...field].forEach((input) => { input.checked = chosen.includes(input.value); });
      } else if (field.type === 'checkbox') field.checked = val === true;
      else if (Array.isArray(val)) field.value = val.join('\n');
      else field.value = val ?? '';
    }
  }

  function readSettings() {
    const settings = state.data?.settings || {};
    const schedule = settings.schedule || {};
    const brand = settings.brand || {};
    const guardrails = settings.guardrails || {};
    setFormValues($('#content-form'), {
      brandName: brand.name, voice: brand.voice, audienceNotes: brand.audienceNotes,
      gameWhitelist: (settings.gameWhitelist || []).join('\n'),
      trackedTopup: settings.trackedLinks?.topup || '', trackedAccount: settings.trackedLinks?.account || '',
      forbiddenClaims: (guardrails.forbiddenClaims || []).join('\n'),
      approvedClaims: (guardrails.approvedClaims || []).join('\n'),
      guardrailsApproved: guardrails.approved,
    });
    setFormValues($('#schedule-form'), {
      intervalHours: schedule.intervalHours ?? 6,
      timezone: schedule.timezone || 'Asia/Kuala_Lumpur',
      activeDays: schedule.activeDays || [1, 2, 3, 4, 5, 6, 7],
      activeStart: schedule.activeStart || '09:00', activeEnd: schedule.activeEnd || '22:00',
      priceMode: settings.priceMode || 'OFF',
    });
    for (const service of ['topup', 'account']) {
      const fact = state.data?.facts?.[service]?.summary || {};
      const form = $(`#fact-${service}-form`);
      setFormValues(form, { ...fact, attributes: (fact.attributes || []).join('\n') });
      const updated = state.data?.facts?.[service]?.updatedAt;
      $('[data-updated]', form).textContent = updated ? `Dikemas kini ${new Date(updated).toLocaleString('ms-MY')}` : 'Belum dikemas kini';
    }
  }

  function renderOnboarding(items = []) {
    const list = $('#onboarding-list');
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      if (!item.complete) li.classList.add('incomplete');
      li.textContent = item.label || item.key || 'Keperluan onboarding';
      return li;
    }));
    const missing = items.filter((item) => !item.complete).length;
    const badge = $('#onboarding-count'); badge.textContent = missing ? `${missing} belum lengkap` : 'Lengkap';
    badge.className = `pill ${missing ? 'warning' : 'good'}`;
  }

  function renderPosts(posts = []) {
    const body = $('#posts-table');
    const rows = posts.map((post) => {
      const tr = document.createElement('tr');
      const time = document.createElement('td'); time.textContent = post.scheduledAt || post.createdAt ? new Date(post.scheduledAt || post.createdAt).toLocaleString('ms-MY') : '—';
      const pillar = document.createElement('td'); pillar.textContent = post.pillar === 'account' ? 'Akaun ML' : post.pillar === 'topup' ? 'Top-up' : '—';
      const statusCell = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status-label ${post.status || ''}`; badge.textContent = escapeText(post.status || 'unknown'); statusCell.append(badge);
      const caption = document.createElement('td'); caption.textContent = post.caption || post.errorCode || '—';
      tr.append(time, pillar, statusCell, caption); return tr;
    });
    if (!rows.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'Belum ada sejarah penerbitan.'; row.append(cell); rows.push(row); }
    body.replaceChildren(...rows);
  }

  function renderActivity(events = []) {
    const target = $('#activity-list');
    const rows = events.map((event) => {
      const row = document.createElement('div'); row.className = 'activity-item';
      const time = document.createElement('time'); time.textContent = event.createdAt ? new Date(event.createdAt).toLocaleString('ms-MY') : '—';
      const title = document.createElement('strong'); title.textContent = escapeText(event.event || event.action || 'Aktiviti');
      const details = document.createElement('span'); details.textContent = escapeText(event.message || event.code || event.status || event.errorCode || '');
      row.append(time, title, details); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Belum ada aktiviti.'; rows.push(empty); }
    target.replaceChildren(...rows);
  }

  function render(data) {
    state.data = data;
    const automation = data.automation || {};
    $('#automation-label').textContent = automation.enabled ? 'Automasi aktif' : 'Automasi dimatikan';
    $('#automation-reason').textContent = automation.enabled ? 'Job akan berjalan mengikut jadual.' : 'Selesaikan onboarding sebelum mengaktifkan.';
    const dot = $('#automation-state'); dot.className = `state-dot ${automation.enabled ? 'on' : automation.paused ? 'paused' : 'off'}`;
    const control = $('#automation-button'); control.textContent = automation.enabled ? 'Jeda kecemasan' : 'Aktifkan automasi'; control.className = `button ${automation.enabled ? 'danger' : 'primary'}`;
    const provider = data.provider || {};
    $('#provider-status').textContent = provider.connected ? (provider.status || 'Disambungkan') : 'Belum disambungkan';
    $('#provider-account').textContent = provider.username ? `@${provider.username}` : 'Sambungkan melalui Tebar';
    $('#metric-success').textContent = String(data.metrics?.success30d ?? 0);
    $('#metric-clicks').textContent = data.metrics?.clicks?.available ? String(data.metrics.clicks.value) : 'Belum tersedia';
    $('#metric-failed').textContent = String(data.metrics?.attention ?? 0);
    $('#metric-facts').textContent = `${data.metrics?.freshFacts ?? 0} / 2`;
    renderOnboarding(data.onboarding || []); renderPosts(data.posts || []); renderActivity(data.activity || []); readSettings();
  }

  async function refresh() { render(await api('/api/dashboard')); hide('#global-error'); }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault(); hide('#login-error');
    try {
      const form = event.currentTarget;
      const result = await api('/api/session/login', { method: 'POST', body: JSON.stringify({ email: value(form, 'email'), password: value(form, 'password') }) });
      state.csrf = result.csrfToken || '';
      setAuthenticated(true); await refresh();
    } catch (error) { show('#login-error', errorText(error)); }
  });

  $('#logout-button').addEventListener('click', async () => {
    try { await api('/api/session/logout', { method: 'POST', body: '{}' }); } finally { state.csrf = ''; setAuthenticated(false); }
  });

  $('#content-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    const settings = state.data.settings || {};
    settings.brand = { name: value(form, 'brandName'), voice: value(form, 'voice'), audienceNotes: value(form, 'audienceNotes') };
    settings.gameWhitelist = lines(value(form, 'gameWhitelist'));
    settings.trackedLinks = { ...(settings.trackedLinks || {}), topup: value(form, 'trackedTopup'), account: value(form, 'trackedAccount') };
    settings.guardrails = { ...(settings.guardrails || {}), approved: form.elements.guardrailsApproved.checked, forbiddenClaims: lines(value(form, 'forbiddenClaims')), approvedClaims: lines(value(form, 'approvedClaims')) };
    try { state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); show('#global-success', 'Panduan jenama berjaya disimpan.'); await refresh(); } catch (error) { show('#global-error', errorText(error)); }
  });

  $('#schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const settings = state.data.settings || {};
    settings.schedule = { intervalHours: Number(value(form, 'intervalHours')), timezone: value(form, 'timezone'), activeDays: $$('input[name="activeDays"]:checked', form).map((input) => Number(input.value)), activeStart: value(form, 'activeStart'), activeEnd: value(form, 'activeEnd') };
    settings.priceMode = value(form, 'priceMode');
    try { state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); show('#global-success', 'Jadual berjaya disimpan.'); await refresh(); } catch (error) { show('#global-error', errorText(error)); }
  });

  $$('.fact-form').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault(); const service = form.dataset.service;
    const summary = service === 'topup'
      ? { game: value(form, 'game'), denomination: value(form, 'denomination'), price: value(form, 'price'), availability: value(form, 'availability') }
      : { game: 'Mobile Legends', price: value(form, 'price'), availability: value(form, 'availability'), attributes: lines(value(form, 'attributes')) };
    Object.keys(summary).forEach((key) => { if (!summary[key] || (Array.isArray(summary[key]) && !summary[key].length)) delete summary[key]; });
    try { await api(`/api/facts/${service}`, { method: 'PUT', body: JSON.stringify({ summary, active: true }) }); show('#global-success', 'Fakta produk berjaya disimpan.'); await refresh(); } catch (error) { show('#global-error', errorText(error)); }
  }));

  $('#automation-button').addEventListener('click', async () => {
    try {
      if (state.data?.automation?.enabled) {
        const result = await api('/api/automation/pause', { method: 'POST', body: '{}' });
        show('#global-success', result.message || 'Automasi dijeda.');
      } else {
        if (!window.confirm('Aktifkan penerbitan automatik untuk workspace yang sedang disambungkan?')) return;
        await api('/api/automation/enable', { method: 'POST', body: '{}' }); show('#global-success', 'Automasi berjaya diaktifkan.');
      }
      await refresh();
    } catch (error) { show('#global-error', errorText(error)); }
  });

  $('#refresh-button').addEventListener('click', () => refresh().catch((error) => show('#global-error', errorText(error))));
  $$('.tab').forEach((button) => button.addEventListener('click', () => {
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`));
  }));

  buildDays();
  api('/api/session').then((data) => {
    if (!data.authenticated) { setAuthenticated(false); return; }
    state.csrf = data.csrfToken || ''; setAuthenticated(true); return refresh();
  }).catch(() => setAuthenticated(false));
})();
