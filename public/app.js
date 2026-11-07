(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { csrf: '', data: null, templates: [] };
  let templateDialogState = null;
  const builtinVoiceTemplates = [
    { id: 'voice-friendly', name: 'Ramah, santai, informatif', description: 'Gaya dasar Kedai Merzz untuk gamer.', voice: 'Ramah, santai seperti gamer, natural, dan tetap informatif. Gunakan bahasa Melayu Malaysia dengan istilah game yang umum.' },
    { id: 'voice-community', name: 'Santai-komunitas', description: 'Terasa seperti ngobrol dengan sesama pemain.', voice: 'Santai dan akrab seperti komunitas gamer Malaysia. Ajak interaksi dengan pertanyaan ringan, tanpa memaksa dan tanpa klaim produk yang tidak terverifikasi. Tulis dalam bahasa Melayu Malaysia.' },
    { id: 'voice-concise', name: 'Ringkas-promosional', description: 'Pesan padat dengan CTA wajar, tanpa membuat promo.', voice: 'Ringkas, jelas, dan berorientasi informasi layanan. Gunakan ajakan bertindak yang wajar; jangan mengarang diskon, urgensi, harga, stok, atau promosi. Tulis dalam bahasa Melayu Malaysia.' },
    { id: 'voice-educational', name: 'Edukatif-fokus kepercayaan', description: 'Bantu pelanggan memahami hal yang perlu diperiksa.', voice: 'Edukatif dan membangun kepercayaan. Jelaskan pertimbangan pembelian secara netral, akui batas informasi, hindari jaminan keamanan atau hasil yang tidak disetujui. Tulis dalam bahasa Melayu Malaysia.' },
  ];
  const escapeText = (value) => String(value ?? '');
  const show = (selector, text) => { const el = $(selector); el.textContent = text; el.hidden = false; };
  const hide = (selector) => { $(selector).hidden = true; };
  const errors = {
    INVALID_EMAIL: 'Format email tidak valid.', INVALID_PASSWORD: 'Kata sandi harus terdiri dari 12 sampai 256 karakter.',
    ADMIN_EXISTS: 'Email tersebut sudah digunakan oleh akun admin lain.', LAST_ADMIN: 'Admin aktif terakhir tidak dapat dinonaktifkan.',
    CANNOT_DEACTIVATE_SELF: 'Anda tidak dapat menonaktifkan akun yang sedang digunakan.', ADMIN_NOT_FOUND: 'Akun admin tidak ditemukan.',
    INVALID_ADMIN: 'Data akun admin tidak valid.', EMPTY_ADMIN_UPDATE: 'Tidak ada perubahan untuk disimpan.',
    INVALID_TEMPLATE: 'Data template tidak valid.', INVALID_TEMPLATE_DATA: 'Isi template tidak sesuai dengan jenisnya.',
    TEMPLATE_EXISTS: 'Nama template tersebut sudah digunakan pada kategori ini.', TEMPLATE_NOT_FOUND: 'Template tidak ditemukan.',
    GAME_NOT_WHITELISTED: 'Game harus lebih dulu disetujui di whitelist Konten & brand.',
    SCHEDULER_DISABLED: 'Scheduler belum aktif di server. Minta administrator menyalakan scheduler sebelum mengaktifkan otomasi.',
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
      intervalHours: schedule.intervalHours ?? 1,
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

  function templateDataFromForm(category) {
    if (category === 'brand') return {
      brandName: value($('#content-form'), 'brandName'), voice: value($('#content-form'), 'voice'),
      audienceNotes: value($('#content-form'), 'audienceNotes'), gameWhitelist: lines(value($('#content-form'), 'gameWhitelist')),
      trackedTopup: value($('#content-form'), 'trackedTopup'), trackedAccount: value($('#content-form'), 'trackedAccount'),
      forbiddenClaims: lines(value($('#content-form'), 'forbiddenClaims')), approvedClaims: lines(value($('#content-form'), 'approvedClaims')),
    };
    if (category === 'topup') return { game: value($('#fact-topup-form'), 'game').trim(), denomination: value($('#fact-topup-form'), 'denomination').trim() };
    return { attributes: lines(value($('#fact-account-form'), 'attributes')) };
  }

  function savedGameWhitelist() { return state.data?.settings?.gameWhitelist || []; }

  function applyTemplate(template) {
    if (template.category === 'brand') {
      const data = template.data || {};
      setFormValues($('#content-form'), {
        brandName: data.brandName, voice: data.voice, audienceNotes: data.audienceNotes,
        gameWhitelist: (data.gameWhitelist || []).join('\n'), trackedTopup: data.trackedTopup, trackedAccount: data.trackedAccount,
        forbiddenClaims: (data.forbiddenClaims || []).join('\n'), approvedClaims: (data.approvedClaims || []).join('\n'), guardrailsApproved: false,
      });
      show('#global-success', 'Template diterapkan ke form Konten & brand. Periksa lalu simpan panduan.');
      activateTab('content'); $('#content-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (template.category === 'topup') {
      if (!savedGameWhitelist().includes(template.data?.game)) { show('#global-error', 'Template tidak diterapkan. Simpan game tersebut di whitelist Konten & brand terlebih dahulu.'); return; }
      setFormValues($('#fact-topup-form'), { game: template.data.game, denomination: template.data.denomination });
      show('#global-success', 'Template diterapkan ke form Top-up. Lengkapi harga dan ketersediaan, lalu simpan.');
      activateTab('facts'); $('#fact-topup-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    setFormValues($('#fact-account-form'), { attributes: (template.data?.attributes || []).join('\n') });
    show('#global-success', 'Template diterapkan ke form atribut akun. Lengkapi harga dan ketersediaan, lalu simpan.');
    activateTab('facts'); $('#fact-account-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderTemplateCards(target, templates, emptyText) {
    const container = $(target);
    if (!templates.length) { container.replaceChildren(Object.assign(document.createElement('p'), { className: 'muted template-empty', textContent: emptyText })); return; }
    container.replaceChildren(...templates.map((template) => {
      const card = document.createElement('article'); card.className = 'template-card';
      const title = document.createElement('h3'); title.textContent = template.name;
      const detail = document.createElement('p'); detail.className = 'muted';
      detail.textContent = template.category === 'brand' ? 'Panduan konten dan brand' : template.category === 'topup' ? `${template.data?.game || 'Game'} · ${template.data?.denomination || 'Nominal'}` : `${(template.data?.attributes || []).length} atribut akun`;
      const actions = document.createElement('div'); actions.className = 'template-card-actions';
      const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'button primary'; apply.textContent = 'Terapkan'; apply.addEventListener('click', () => applyTemplate(template));
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'button quiet'; edit.textContent = 'Ubah'; edit.addEventListener('click', () => openTemplateDialog({ mode: 'edit', ...template }));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button danger'; remove.textContent = 'Hapus'; remove.addEventListener('click', async () => {
        if (!window.confirm(`Hapus template “${template.name}”?`)) return;
        try { await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' }); await loadTemplates(); show('#global-success', 'Template berhasil dihapus.'); }
        catch (error) { show('#global-error', errorText(error)); }
      });
      actions.append(apply, edit, remove); card.append(title, detail, actions); return card;
    }));
  }

  async function loadTemplates() {
    for (const id of ['#brand-template-list', '#topup-template-list', '#account-template-list']) $(id).replaceChildren(Object.assign(document.createElement('p'), { className: 'muted template-empty', textContent: 'Memuat template…' }));
    const result = await api('/api/templates'); state.templates = result.templates || [];
    renderTemplateCards('#brand-template-list', state.templates.filter((item) => item.category === 'brand'), 'Belum ada template konten & brand. Simpan dari form Konten & brand.');
    renderTemplateCards('#topup-template-list', state.templates.filter((item) => item.category === 'topup'), 'Belum ada template top-up. Simpan dari form Produk & informasi.');
    renderTemplateCards('#account-template-list', state.templates.filter((item) => item.category === 'account'), 'Belum ada template atribut akun. Simpan dari form Produk & informasi.');
  }

  function renderBuiltinTemplates() {
    const target = $('#builtin-template-list');
    target.replaceChildren(...builtinVoiceTemplates.map((template) => {
      const card = document.createElement('article'); card.className = 'template-card builtin-template';
      const title = document.createElement('h3'); title.textContent = template.name;
      const detail = document.createElement('p'); detail.className = 'muted'; detail.textContent = template.description;
      const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'button primary'; apply.textContent = 'Gunakan gaya ini';
      apply.addEventListener('click', () => { $('#content-form').elements.voice.value = template.voice; activateTab('content'); $('#content-form').elements.voice.scrollIntoView({ behavior: 'smooth', block: 'center' }); show('#global-success', 'Gaya komunikasi diterapkan. Periksa lalu simpan panduan.'); });
      card.append(title, detail, apply); return card;
    }));
  }

  function editorControl(labelText, name, val, { multiline = false, options = null, hint = '' } = {}) {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    if (hint) { const note = document.createElement('span'); note.className = 'field-hint'; note.textContent = hint; label.append(note); }
    const field = document.createElement(multiline ? 'textarea' : options ? 'select' : 'input'); field.name = name; field.value = Array.isArray(val) ? val.join('\n') : val || '';
    if (multiline) field.rows = 3;
    if (options) {
      field.replaceChildren(...options.map((item) => { const option = document.createElement('option'); option.value = item; option.textContent = item; return option; }));
      field.value = val && options.includes(val) ? val : '';
    }
    label.append(field); return label;
  }

  function openTemplateDialog({ mode, id = null, category, name = '', data = {} }) {
    templateDialogState = { mode, id, category };
    $('#template-dialog-title').textContent = mode === 'edit' ? 'Ubah template' : 'Simpan template';
    const form = $('#template-dialog-form'); form.elements.templateName.value = name;
    const fields = $('#template-editor-fields'); fields.replaceChildren();
    if (category === 'brand') fields.append(
      editorControl('Nama brand', 'brandName', data.brandName), editorControl('Gaya komunikasi', 'voice', data.voice),
      editorControl('Wawasan pelanggan', 'audienceNotes', data.audienceNotes, { multiline: true }),
      editorControl('Game top-up dalam whitelist', 'gameWhitelist', data.gameWhitelist, { multiline: true, hint: 'Simpan hanya game yang sudah ada di whitelist.' }),
      editorControl('Tautan top-up', 'trackedTopup', data.trackedTopup), editorControl('Tautan akun', 'trackedAccount', data.trackedAccount),
      editorControl('Klaim dilarang', 'forbiddenClaims', data.forbiddenClaims, { multiline: true }), editorControl('Klaim disetujui', 'approvedClaims', data.approvedClaims, { multiline: true }),
    );
    else if (category === 'topup') fields.append(
      editorControl('Game', 'game', data.game, { options: savedGameWhitelist() }),
      editorControl('Ringkasan nominal', 'denomination', data.denomination),
    );
    else fields.append(editorControl('Atribut akun', 'attributes', data.attributes, { multiline: true, hint: 'Satu atribut yang telah disetujui per baris.' }));
    hide('#template-dialog-error'); $('#template-dialog').showModal();
  }

  function readTemplateEditor(category) {
    const form = $('#template-dialog-form'); const val = (name) => new FormData(form).get(name) || '';
    if (category === 'brand') return {
      brandName: val('brandName'), voice: val('voice'), audienceNotes: val('audienceNotes'), gameWhitelist: lines(val('gameWhitelist')),
      trackedTopup: val('trackedTopup'), trackedAccount: val('trackedAccount'), forbiddenClaims: lines(val('forbiddenClaims')), approvedClaims: lines(val('approvedClaims')),
    };
    if (category === 'topup') return { game: val('game'), denomination: val('denomination') };
    return { attributes: lines(val('attributes')) };
  }

  function activateTab(name) {
    const button = $(`.tab[data-tab="${name}"]`);
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`));
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

  $$('[data-save-template]').forEach((button) => button.addEventListener('click', () => {
    const category = button.dataset.saveTemplate;
    const data = templateDataFromForm(category);
    if (category === 'topup' && !savedGameWhitelist().includes(data.game)) { show('#global-error', 'Game perlu disimpan di whitelist Konten & brand terlebih dahulu.'); return; }
    openTemplateDialog({ mode: 'create', category, data });
  }));
  $('#template-dialog-cancel').addEventListener('click', () => $('#template-dialog').close());
  $('#template-dialog-form').addEventListener('submit', async (event) => {
    event.preventDefault(); hide('#template-dialog-error');
    const form = event.currentTarget; const name = value(form, 'templateName').trim();
    const payload = { name, data: readTemplateEditor(templateDialogState.category) };
    try {
      if (templateDialogState.mode === 'edit') await api(`/api/templates/${encodeURIComponent(templateDialogState.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      else await api('/api/templates', { method: 'POST', body: JSON.stringify({ ...payload, category: templateDialogState.category }) });
      $('#template-dialog').close(); await loadTemplates(); show('#global-success', templateDialogState.mode === 'edit' ? 'Template diperbarui.' : 'Template disimpan dan dibagikan kepada semua admin.');
    } catch (error) { show('#template-dialog-error', errorText(error)); }
  });

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
    settings.schedule = { intervalHours: Number(value(form, 'intervalHours')) };
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
        if (!window.confirm('Aktifkan penerbitan otomatis untuk workspace yang sedang terhubung? Sistem akan langsung memproses utas pertama, lalu menerbitkan berdasarkan interval yang tersimpan.')) return;
        const result = await api('/api/automation/enable', { method: 'POST', body: '{}' });
        const firstPostAt = result.firstPostAt ? new Date(result.firstPostAt).toLocaleString('id-ID', { timeZone: 'Asia/Kuala_Lumpur' }) : null;
        show('#global-success', result.immediate
          ? 'Otomasi aktif. Utas pertama sedang diproses.'
          : `Otomasi aktif. Posting pertama dijadwalkan pada ${firstPostAt || 'setelah jeda minimum satu jam'}.`);
      }
      await refresh();
    } catch (error) { show('#global-error', errorText(error)); }
  });

  $('#refresh-button').addEventListener('click', () => refresh().catch((error) => show('#global-error', errorText(error))));
  $$('.tab').forEach((button) => button.addEventListener('click', () => {
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`));
    if (button.dataset.tab === 'admins') loadAdmins().catch((error) => show('#global-error', errorText(error)));
    if (button.dataset.tab === 'templates') loadTemplates().catch((error) => show('#global-error', errorText(error)));
  }));

  renderBuiltinTemplates();
  $$('input[type="password"]').forEach(addPasswordToggle);
  api('/api/session').then((data) => {
    if (!data.authenticated) { setAuthenticated(false); return; }
    state.csrf = data.csrfToken || ''; setAuthenticated(true); return refresh();
  }).catch(() => setAuthenticated(false));
})();
