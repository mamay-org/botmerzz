(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const days = [[1, 'Sen'], [2, 'Sel'], [3, 'Rab'], [4, 'Kam'], [5, 'Jum'], [6, 'Sab'], [7, 'Min']];
  const state = { csrf: '', data: null };
  const escapeText = (value) => String(value ?? '');
  const show = (selector, text) => { const el = $(selector); el.textContent = text; el.hidden = false; };
  const hide = (selector) => { $(selector).hidden = true; };
  const errors = {
    INVALID_EMAIL: 'Format email tidak valid.', INVALID_PASSWORD: 'Kata sandi harus terdiri dari 12 sampai 256 karakter.',
    ADMIN_EXISTS: 'Email tersebut sudah digunakan oleh akun admin lain.', LAST_ADMIN: 'Admin aktif terakhir tidak dapat dinonaktifkan.',
    CANNOT_DEACTIVATE_SELF: 'Anda tidak dapat menonaktifkan akun yang sedang digunakan.', ADMIN_NOT_FOUND: 'Akun admin tidak ditemukan.',
    INVALID_ADMIN: 'Data akun admin tidak valid.', EMPTY_ADMIN_UPDATE: 'Tidak ada perubahan untuk disimpan.',
    AUTH_REQUIRED: 'Sesi login berakhir. Silakan masuk kembali.', CSRF_REJECTED: 'Sesi keamanan kedaluwarsa. Muat ulang halaman lalu coba lagi.',
  };
  const errorText = (error) => errors[error?.message] || error?.message || 'Permintaan gagal. Silakan coba lagi.';
  const onboardingLabels = {
    brand: 'Nama dan gaya komunikasi brand sudah diisi',
    games: 'Daftar game top-up sudah diisi',
    guardrails: 'Batasan AI sudah disetujui klien',
    links: 'Tautan halaman utama sudah diisi',
    facts: 'Informasi top-up dan akun sudah diperbarui',
    thread: 'Akun Threads testing aktif di Tebar',
    ai: 'Penyedia AI sudah dikonfigurasi',
  };
  const statusLabels = {
    pending: 'Menunggu', generating: 'Membuat konten', ready: 'Siap diterbitkan',
    publishing: 'Sedang diterbitkan', published: 'Berhasil diterbitkan',
    failed: 'Gagal', skipped: 'Dilewati', canceled: 'Dibatalkan',
    partial: 'Sebagian berhasil', unknown: 'Belum diketahui', scheduled: 'Terjadwal',
  };
  const activityLabels = {
    post_published: 'Posting berhasil diterbitkan', publish_accepted: 'Posting diterima penyedia',
    publish_failed: 'Penerbitan gagal', publish_outcome_unknown: 'Status penerbitan belum diketahui',
    ai_generation_failed: 'Pembuatan konten AI gagal', automation_paused: 'Otomasi dijeda',
    slot_skipped: 'Jadwal posting dilewati', post_cancellation: 'Pembatalan posting',
  };
  function addPasswordToggle(input) {
    if (!input?.parentNode || input.dataset.visibilityToggle === 'ready') return;
    const wrapper = document.createElement('span'); wrapper.className = 'password-field';
    input.parentNode.insertBefore(wrapper, input); wrapper.append(input); input.dataset.visibilityToggle = 'ready';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'password-toggle';
    button.setAttribute('aria-label', 'Tampilkan kata sandi'); button.setAttribute('aria-pressed', 'false');
    const eye = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    const eyeOff = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.2A11.5 11.5 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a11 11 0 0 0 4-.7"></path></svg>';
    button.innerHTML = eye;
    button.addEventListener('click', () => {
      const visible = input.type === 'password'; input.type = visible ? 'text' : 'password';
      button.setAttribute('aria-label', visible ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi');
      button.setAttribute('aria-pressed', String(visible)); button.innerHTML = visible ? eyeOff : eye; input.focus();
    });
    wrapper.append(button);
  }

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
      $('[data-updated]', form).textContent = updated ? `Diperbarui ${new Date(updated).toLocaleString('id-ID')}` : 'Belum diperbarui';
    }
  }

  function renderOnboarding(items = []) {
    const list = $('#onboarding-list');
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement('li');
      if (!item.complete) li.classList.add('incomplete');
      li.textContent = onboardingLabels[item.key] || item.label || item.key || 'Persiapan awal';
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
      const time = document.createElement('td'); time.textContent = post.scheduledAt || post.createdAt ? new Date(post.scheduledAt || post.createdAt).toLocaleString('id-ID') : '—';
      const pillar = document.createElement('td'); pillar.textContent = post.pillar === 'account' ? 'Akun ML' : post.pillar === 'topup' ? 'Top-up' : '—';
      const statusCell = document.createElement('td'); const badge = document.createElement('span'); badge.className = `status-label ${post.status || ''}`; badge.textContent = statusLabels[post.status] || 'Belum diketahui'; statusCell.append(badge);
      const caption = document.createElement('td'); caption.textContent = post.caption || post.errorCode || '—';
      tr.append(time, pillar, statusCell, caption); return tr;
    });
    if (!rows.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 4; cell.textContent = 'Belum ada riwayat posting.'; row.append(cell); rows.push(row); }
    body.replaceChildren(...rows);
  }

  function renderActivity(events = []) {
    const target = $('#activity-list');
    const rows = events.map((event) => {
      const row = document.createElement('div'); row.className = 'activity-item';
      const time = document.createElement('time'); time.textContent = event.createdAt ? new Date(event.createdAt).toLocaleString('id-ID') : '—';
      const title = document.createElement('strong'); title.textContent = activityLabels[event.event || event.action] || 'Aktivitas sistem';
      const details = document.createElement('span'); details.textContent = escapeText(event.message || event.code || event.status || event.errorCode || '');
      row.append(time, title, details); return row;
    });
    if (!rows.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Belum ada aktivitas.'; rows.push(empty); }
    target.replaceChildren(...rows);
  }

  async function loadAdmins() {
    const target = $('#admin-list');
    target.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Memuat daftar admin…' }));
    const { admins = [] } = await api('/api/admins');
    if (!admins.length) { target.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Belum ada akun admin.' })); return; }
    const activeAdminCount = admins.filter((admin) => admin.active).length;
    target.replaceChildren(...admins.map((admin) => {
      const form = document.createElement('form'); form.className = 'panel form-grid admin-row'; form.dataset.adminId = String(admin.id);
      const heading = document.createElement('div'); heading.className = 'panel-heading full';
      const title = document.createElement('div'); const email = document.createElement('h2'); email.textContent = admin.email;
      const status = document.createElement('p'); status.className = 'muted'; status.id = `admin-status-${admin.id}`;
      status.textContent = admin.active && activeAdminCount === 1 ? 'Admin aktif terakhir tidak dapat dinonaktifkan.' : admin.active ? 'Aktif' : 'Dinonaktifkan';
      title.append(email, status); heading.append(title);
      const emailLabel = document.createElement('label'); emailLabel.textContent = 'Email admin';
      const emailInput = document.createElement('input'); emailInput.name = 'email'; emailInput.type = 'email'; emailInput.required = true; emailInput.maxLength = 254; emailInput.value = admin.email; emailLabel.append(emailInput);
      form.dataset.originalEmail = admin.email;
      const passwordLabel = document.createElement('label'); passwordLabel.textContent = 'Kata sandi baru (opsional)';
      const passwordInput = document.createElement('input'); passwordInput.name = 'password'; passwordInput.type = 'password'; passwordInput.autocomplete = 'new-password'; passwordInput.minLength = 12; passwordInput.maxLength = 256; passwordLabel.append(passwordInput); addPasswordToggle(passwordInput);
      const footer = document.createElement('div'); footer.className = 'form-footer full';
      const save = document.createElement('button'); save.className = 'button primary'; save.type = 'submit'; save.textContent = 'Simpan perubahan';
      const toggle = document.createElement('button'); toggle.className = `button ${admin.active ? 'danger' : 'quiet'}`; toggle.type = 'button'; toggle.dataset.active = String(admin.active); toggle.textContent = admin.active ? 'Nonaktifkan' : 'Aktifkan kembali';
      toggle.disabled = admin.active && activeAdminCount === 1;
      toggle.setAttribute('aria-describedby', status.id);
      footer.append(save, toggle); form.append(heading, emailLabel, passwordLabel, footer);
      return form;
    }));
  }

  function render(data) {
    state.data = data;
    const automation = data.automation || {};
    $('#automation-label').textContent = automation.enabled ? 'Otomasi aktif' : 'Otomasi nonaktif';
    $('#automation-reason').textContent = automation.enabled ? 'Tugas berjalan sesuai jadwal.' : 'Selesaikan onboarding sebelum mengaktifkan.';
    const dot = $('#automation-state'); dot.className = `state-dot ${automation.enabled ? 'on' : automation.paused ? 'paused' : 'off'}`;
    const control = $('#automation-button'); control.textContent = automation.enabled ? 'Jeda darurat' : 'Aktifkan otomasi'; control.className = `button ${automation.enabled ? 'danger' : 'primary'}`;
    const provider = data.provider || {};
    $('#provider-status').textContent = provider.connected ? (provider.status || 'Terhubung') : 'Belum terhubung';
    $('#provider-account').textContent = provider.username ? `@${provider.username}` : 'Hubungkan melalui Tebar';
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

  $('#admin-create-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    try {
      await api('/api/admins', { method: 'POST', body: JSON.stringify({ email: value(form, 'email'), password: value(form, 'password') }) });
      form.reset(); show('#global-success', 'Akun admin berhasil ditambahkan.'); await loadAdmins();
    } catch (error) { show('#global-error', errorText(error)); }
  });
  $('#admin-list').addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-admin-id]'); if (!form) return;
    event.preventDefault();
    const changes = {}; const email = value(form, 'email'); if (email !== form.dataset.originalEmail) changes.email = email; const password = value(form, 'password'); if (password) changes.password = password;
    if (!Object.keys(changes).length) { show('#global-success', 'Tidak ada perubahan untuk disimpan.'); return; }
    try {
      const result = await api(`/api/admins/${form.dataset.adminId}`, { method: 'PATCH', body: JSON.stringify(changes) });
      if (result.sessionRevoked) { state.csrf = ''; setAuthenticated(false); show('#login-error', 'Akun diperbarui. Masuk kembali dengan email atau kata sandi baru.'); return; }
      show('#global-success', 'Perubahan akun admin berhasil disimpan.'); await loadAdmins();
    } catch (error) { show('#global-error', errorText(error)); }
  });
  $('#admin-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-active]'); if (!button) return;
    const form = button.closest('form[data-admin-id]'); const active = button.dataset.active !== 'true';
    if (!active && !window.confirm('Nonaktifkan akun ini? Semua sesi login akun akan dihentikan.')) return;
    try { await api(`/api/admins/${form.dataset.adminId}`, { method: 'PATCH', body: JSON.stringify({ active }) }); show('#global-success', active ? 'Akun admin diaktifkan kembali.' : 'Akun admin dinonaktifkan.'); await loadAdmins(); }
    catch (error) { show('#global-error', errorText(error)); }
  });
  $('#admins-refresh-button').addEventListener('click', () => loadAdmins().catch((error) => show('#global-error', errorText(error))));

  $('#content-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    const settings = state.data.settings || {};
    settings.brand = { name: value(form, 'brandName'), voice: value(form, 'voice'), audienceNotes: value(form, 'audienceNotes') };
    settings.gameWhitelist = lines(value(form, 'gameWhitelist'));
    settings.trackedLinks = { ...(settings.trackedLinks || {}), topup: value(form, 'trackedTopup'), account: value(form, 'trackedAccount') };
    settings.guardrails = { ...(settings.guardrails || {}), approved: form.elements.guardrailsApproved.checked, forbiddenClaims: lines(value(form, 'forbiddenClaims')), approvedClaims: lines(value(form, 'approvedClaims')) };
    try { state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); show('#global-success', 'Panduan merek berhasil disimpan.'); await refresh(); } catch (error) { show('#global-error', errorText(error)); }
  });

  $('#schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const settings = state.data.settings || {};
    settings.schedule = { intervalHours: Number(value(form, 'intervalHours')), timezone: value(form, 'timezone'), activeDays: $$('input[name="activeDays"]:checked', form).map((input) => Number(input.value)), activeStart: value(form, 'activeStart'), activeEnd: value(form, 'activeEnd') };
    settings.priceMode = value(form, 'priceMode');
    try { state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }); show('#global-success', 'Jadwal berhasil disimpan.'); await refresh(); } catch (error) { show('#global-error', errorText(error)); }
  });

  $$('.fact-form').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault(); const service = form.dataset.service;
    const summary = service === 'topup'
      ? { game: value(form, 'game'), denomination: value(form, 'denomination'), price: value(form, 'price'), availability: value(form, 'availability') }
      : { game: 'Mobile Legends', price: value(form, 'price'), availability: value(form, 'availability'), attributes: lines(value(form, 'attributes')) };
    Object.keys(summary).forEach((key) => { if (!summary[key] || (Array.isArray(summary[key]) && !summary[key].length)) delete summary[key]; });
    try { await api(`/api/facts/${service}`, { method: 'PUT', body: JSON.stringify({ summary, active: true }) }); show('#global-success', 'Informasi produk berhasil disimpan.'); await refresh(); } catch (error) { show('#global-error', errorText(error)); }
  }));

  $('#automation-button').addEventListener('click', async () => {
    try {
      if (state.data?.automation?.enabled) {
        const result = await api('/api/automation/pause', { method: 'POST', body: '{}' });
        show('#global-success', result.message || 'Otomasi dijeda.');
      } else {
        if (!window.confirm('Aktifkan penerbitan otomatis untuk workspace yang sedang terhubung?')) return;
        await api('/api/automation/enable', { method: 'POST', body: '{}' }); show('#global-success', 'Otomasi berhasil diaktifkan.');
      }
      await refresh();
    } catch (error) { show('#global-error', errorText(error)); }
  });

  $('#refresh-button').addEventListener('click', () => refresh().catch((error) => show('#global-error', errorText(error))));
  $$('.tab').forEach((button) => button.addEventListener('click', () => {
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`));
    if (button.dataset.tab === 'admins') loadAdmins().catch((error) => show('#global-error', errorText(error)));
  }));

  $$('input[type="password"]').forEach(addPasswordToggle);
  buildDays();
  api('/api/session').then((data) => {
    if (!data.authenticated) { setAuthenticated(false); return; }
    state.csrf = data.csrfToken || ''; setAuthenticated(true); return refresh();
  }).catch(() => setAuthenticated(false));
})();
