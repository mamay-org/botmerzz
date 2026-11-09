(() => {
  'use strict';
  function parseRetryAfterSeconds(payloadValue, headerValue) {
    for (const value of [payloadValue, headerValue]) {
      const seconds = typeof value === 'number' ? value
        : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value)
          : NaN;
      if (Number.isSafeInteger(seconds) && seconds > 0) return seconds;
    }
    return null;
  }
  function formatLoginWait(retryAfterSeconds) {
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
      return 'Terlalu banyak percobaan masuk. Tunggu beberapa saat lalu coba lagi.';
    }
    const hours = Math.floor(retryAfterSeconds / 3600);
    const minutes = Math.floor((retryAfterSeconds % 3600) / 60);
    const seconds = retryAfterSeconds % 60;
    const duration = [];
    if (hours) duration.push(hours + ' jam');
    if (minutes) duration.push(minutes + ' menit');
    if (seconds || !duration.length) duration.push(seconds + ' detik');
    return 'Terlalu banyak percobaan masuk. Coba lagi dalam ' + duration.join(' ') + '.';
  }
  async function withPending(control, action, progressText, form = control?.closest?.('form')) {
    if (!control || control.disabled || control.dataset.pending === 'true' || form?.dataset.pending === 'true') return false;
    const originalText = control.textContent;
    const originalDisabled = control.disabled;
    const originalBusy = form?.getAttribute('aria-busy');
    const formControls = form ? [...form.elements].map((field) => [field, field.disabled]) : [];
    control.dataset.pending = 'true';
    if (form) {
      form.dataset.pending = 'true';
      form.setAttribute('aria-busy', 'true');
      formControls.forEach(([field]) => { field.disabled = true; });
    }
    control.disabled = true;
    control.setAttribute('aria-busy', 'true');
    if (progressText) control.textContent = progressText;
    try {
      return await action();
    } finally {
      delete control.dataset.pending;
      control.disabled = originalDisabled;
      control.textContent = originalText;
      control.removeAttribute('aria-busy');
      if (control.id === 'integration-check-active') control.disabled = !state.integrations?.configuration?.profileId || !state.integrations?.configuration?.accountId;
      if (form) {
        formControls.forEach(([field, disabled]) => { field.disabled = disabled; });
        delete form.dataset.pending;
        if (originalBusy === null) form.removeAttribute('aria-busy');
        else form.setAttribute('aria-busy', originalBusy);
        if (form.id === 'integration-account-form' || form.id === 'integration-model-form') syncIntegrationControls();
      }
    }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { withPending, parseRetryAfterSeconds, formatLoginWait };
    return;
  }
  if (typeof document === 'undefined') return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { csrf: '', data: null, templates: [], integrations: null, integrationVerification: null, dashboardLoad: 0, onboardingComplete: null, onboardingExpanded: false };
  let templateDialogState = null;
  const builtinVoiceTemplates = [
    { id: 'voice-friendly', name: 'Ramah, santai, informatif', description: 'Gaya dasar Kedai Merzz untuk gamer.', voice: 'Ramah, santai seperti gamer, natural, dan tetap informatif. Gunakan bahasa Melayu Malaysia dengan istilah game yang umum.' },
    { id: 'voice-community', name: 'Santai-komunitas', description: 'Terasa seperti ngobrol dengan sesama pemain.', voice: 'Santai dan akrab seperti komunitas gamer Malaysia. Ajak interaksi dengan pertanyaan ringan, tanpa memaksa dan tanpa klaim produk yang tidak terverifikasi. Tulis dalam bahasa Melayu Malaysia.' },
    { id: 'voice-concise', name: 'Ringkas-promosional', description: 'Pesan padat dengan CTA wajar, tanpa membuat promo.', voice: 'Ringkas, jelas, dan berorientasi informasi layanan. Gunakan ajakan bertindak yang wajar; jangan mengarang diskon, urgensi, harga, stok, atau promosi. Tulis dalam bahasa Melayu Malaysia.' },
    { id: 'voice-educational', name: 'Edukatif-fokus kepercayaan', description: 'Bantu pelanggan memahami hal yang perlu diperiksa.', voice: 'Edukatif dan membangun kepercayaan. Jelaskan pertimbangan pembelian secara netral, akui batas informasi, hindari jaminan keamanan atau hasil yang tidak disetujui. Tulis dalam bahasa Melayu Malaysia.' },
  ];
  const escapeText = (value) => String(value ?? '');
  const toastTimers = new WeakMap();
  const toastHistory = new Map();
  function notify(type, message) {
    const text = String(message || '').trim();
    const region = $('#toast-region');
    if (!text || !region) return;
    const key = `${type}:${text}`;
    const now = Date.now();
    if (now - (toastHistory.get(key) || 0) < 1800) return;
    toastHistory.set(key, now);
    for (const [oldKey, time] of toastHistory) if (now - time > 5000) toastHistory.delete(oldKey);
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-atomic', 'true');
    const icon = document.createElement('span'); icon.className = 'toast-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ({ success: '✓', error: '!', warning: '⚠', info: 'i' })[type] || 'i';
    const content = document.createElement('span'); content.className = 'toast-message'; content.textContent = text;
    const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', 'Tutup notifikasi'); close.textContent = '×';
    close.addEventListener('click', () => { clearTimeout(toastTimers.get(toast)); toast.remove(); });
    toast.append(icon, content, close); region.append(toast);
    const timer = type === 'error' || type === 'warning' ? 10000 : 5000;
    toastTimers.set(toast, setTimeout(() => toast.remove(), timer));
  }
  const show = (selector, text) => {
    const el = $(selector); el.textContent = text; el.hidden = false;
    if (selector === '#global-success') notify('success', text);
    else if (selector === '#global-error' || selector === '#login-error') {
      const partialSuccess = /ringkasan dashboard belum dapat diperbarui/i.test(text);
      notify(partialSuccess ? 'info' : /konflik|validasi|belum selesai|belum lengkap|periksa/i.test(text) ? 'warning' : 'error', partialSuccess ? `Perubahan berhasil disimpan, tetapi ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);
    }
    else if (selector === '#integration-account-error' || selector === '#integration-model-error' || selector === '#template-dialog-error') notify('error', text);
  };
  function confirmAction(message) {
    const confirmed = window.confirm(message);
    if (!confirmed) notify('info', 'Tindakan dibatalkan. Tidak ada perubahan yang disimpan.');
    return confirmed;
  }
  async function refreshAfterMutation(loader) {
    try { await loader(); }
    catch { notify('info', 'Perubahan berhasil disimpan, tetapi tampilan belum dapat diperbarui. Muat ulang dashboard.'); }
  }
  const hide = (selector) => { $(selector).hidden = true; };
  const errors = {
    INVALID_EMAIL: 'Format email tidak valid.', INVALID_PASSWORD: 'Kata sandi harus terdiri dari 12 sampai 256 karakter.',
    ADMIN_EXISTS: 'Email tersebut sudah digunakan oleh akun admin lain.', LAST_ADMIN: 'Admin aktif terakhir tidak dapat dinonaktifkan.',
    CANNOT_DEACTIVATE_SELF: 'Anda tidak dapat menonaktifkan akun yang sedang digunakan.', ADMIN_NOT_FOUND: 'Akun admin tidak ditemukan.',
    INVALID_ADMIN: 'Data akun admin tidak valid.', EMPTY_ADMIN_UPDATE: 'Tidak ada perubahan untuk disimpan.',
    INVALID_TEMPLATE: 'Data template tidak valid.', INVALID_TEMPLATE_DATA: 'Isi template tidak sesuai dengan jenisnya.',
    TEMPLATE_EXISTS: 'Nama template tersebut sudah digunakan pada kategori ini.', TEMPLATE_NOT_FOUND: 'Template tidak ditemukan.',
    GAME_NOT_WHITELISTED: 'Game harus lebih dulu disetujui di whitelist Konten & brand.',
    INVALID_SETTINGS: 'Ada data pengaturan yang perlu diperiksa. Lihat pesan pada field yang ditandai.',
    INVALID_KNOWLEDGE: 'Ada panduan brand atau guardrail yang perlu diperiksa.',
    INVALID_FACT: 'Ringkasan produk tidak valid. Periksa kembali isinya.',
    INVALID_FACT_PRICE: 'Harga harus berupa angka dengan maksimal dua angka desimal.',
    INVALID_FACT_FIELDS: 'Periksa kembali game, informasi produk, dan atribut yang diisi.',
    INVALID_ADMIN_STATUS: 'Status akun admin tidak valid.',
    INVALID_CREDENTIALS: 'Email atau kata sandi tidak cocok.',
    LOGIN_RATE_LIMITED: 'Terlalu banyak percobaan masuk. Tunggu beberapa saat lalu coba lagi.',
    ORIGIN_REJECTED: 'Permintaan ditolak karena asal halaman tidak cocok. Muat ulang dashboard lalu coba lagi.',
    RATE_LIMITED: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
    SCHEDULER_DISABLED: 'Scheduler belum aktif di server. Minta administrator menyalakan scheduler sebelum mengaktifkan otomasi.',
    ONBOARDING_INCOMPLETE: 'Lengkapi brand, hashtag, tautan top-up dan jual akun, koneksi Threads, serta penyedia AI sebelum mengaktifkan otomasi.',
    AUTH_REQUIRED: 'Sesi login berakhir. Silakan masuk kembali.', CSRF_REJECTED: 'Sesi keamanan kedaluwarsa. Muat ulang halaman lalu coba lagi.',
    CONFIG_CONFLICT: 'Konfigurasi sudah berubah. Muat ulang konfigurasi dan periksa lagi; isian Anda tetap tersimpan di form.',
    INVALID_ACCOUNT: 'Profile ID atau Account ID tidak valid. Periksa kedua isian.',
    INVALID_MODEL: 'Model ID tidak valid. Periksa kembali format dan nama model.',
    MODEL_INCOMPATIBLE: 'Model tidak mendukung kebutuhan teks atau parameter aplikasi.',
    PROVIDER_UNAVAILABLE: 'Penyedia belum dapat dihubungi. Coba lagi setelah koneksi pulih.',
    SWITCH_BLOCKED: 'Pergantian tertahan karena status posting lama belum pasti. Periksa dan lanjutkan rekonsiliasi.',
    ACCOUNT_NOT_AVAILABLE: 'Akun tidak tersedia pada profile ini, bukan Threads, tidak aktif, atau sedang ditangguhkan.',
    TEBAR_NOT_CONFIGURED: 'Koneksi Tebar belum dikonfigurasi di server.', TEBAR_UNAUTHORIZED: 'Kunci Tebar tidak memiliki akses ke profile ini.',
    TEBAR_UNAVAILABLE: 'Tebar belum dapat dihubungi. Coba lagi nanti.', TEBAR_RATE_LIMITED: 'Tebar membatasi permintaan. Tunggu sebentar lalu coba lagi.',
    MODEL_NOT_FOUND: 'Model tidak ditemukan di OpenRouter.', OPENROUTER_NOT_CONFIGURED: 'Koneksi OpenRouter belum dikonfigurasi di server.',
    OPENROUTER_UNAUTHORIZED: 'Koneksi OpenRouter tidak memiliki izin untuk memeriksa model.', OPENROUTER_UNAVAILABLE: 'OpenRouter belum dapat dihubungi. Coba lagi nanti.',
    OPENROUTER_RATE_LIMITED: 'OpenRouter membatasi permintaan. Tunggu sebentar lalu coba lagi.',
    CONFIG_SWITCH_IN_PROGRESS: 'Pergantian akun masih berlangsung. Selesaikan pemeriksaan terlebih dahulu.',
    CONFIG_VERSION_NOT_RESTORABLE: 'Versi ini tidak dapat dipulihkan karena informasinya belum lengkap.',
    CONFIG_UNAVAILABLE: 'Konfigurasi belum dapat dibaca. Coba lagi atau hubungi administrator server.',
    CONFIG_NOT_LOADED: 'Muat ulang konfigurasi sebelum melanjutkan.',
  };
  const fieldLabels = {
    'brand.name': 'nama brand', 'brand.voice': 'gaya komunikasi', 'brand.contentDirection': 'arahan konten AI',
    'brand.audienceNotes': 'wawasan pelanggan', 'guardrails.approved': 'persetujuan guardrail',
    'guardrails.forbiddenClaims': 'klaim yang dilarang', 'guardrails.approvedClaims': 'klaim yang disetujui',
    'guardrails.hookVocabulary': 'kosakata hook', gameWhitelist: 'whitelist game', hashtags: 'hashtag',
    'trackedLinks.topup': 'tautan top-up', 'trackedLinks.account': 'tautan jual akun',
    'schedule.intervalHours': 'interval posting', 'schedule.timezone': 'zona waktu', priceMode: 'mode harga/stok',
    'summary.game': 'game', 'summary.denomination': 'nominal top-up', 'summary.price': 'harga',
    'summary.availability': 'ketersediaan', 'summary.attributes': 'atribut akun',
    email: 'email', password: 'kata sandi', game: 'game', price: 'harga',
    profileId: 'Profile ID', accountId: 'Account ID', model: 'model ID',
  };
  const fieldNames = {
    'brand.name': 'brandName', 'brand.voice': 'voice', 'brand.contentDirection': 'contentDirection',
    'brand.audienceNotes': 'audienceNotes', 'guardrails.approved': 'guardrailsApproved',
    'guardrails.forbiddenClaims': 'forbiddenClaims', 'guardrails.approvedClaims': 'approvedClaims',
    'guardrails.hookVocabulary': 'hookVocabulary', 'trackedLinks.topup': 'trackedTopup',
    'trackedLinks.account': 'trackedAccount', 'schedule.intervalHours': 'intervalHours',
    'schedule.timezone': 'timezone', priceMode: 'priceMode', 'summary.game': 'game',
    'summary.denomination': 'denomination', 'summary.price': 'price',
    'summary.availability': 'availability', 'summary.attributes': 'attributes',
  };
  const errorText = (error) => {
    const code = error?.code || error?.message;
    if (code === 'LOGIN_RATE_LIMITED') return formatLoginWait(error.retryAfterSeconds);
    if (errors[code]) return errors[code];
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return 'Permintaan belum berhasil. Periksa kembali data atau coba lagi.';
    return code || 'Permintaan gagal. Silakan coba lagi.';
  };
  function clearFieldError(control) {
    const errorId = control?.dataset?.errorId;
    if (!errorId) return;
    document.getElementById(errorId)?.remove();
    control.removeAttribute('aria-invalid');
    const describedBy = (control.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorId);
    if (describedBy.length) control.setAttribute('aria-describedby', describedBy.join(' '));
    else control.removeAttribute('aria-describedby');
    delete control.dataset.errorId;
  }
  function clearFormErrors(form) { [...form.elements].forEach(clearFieldError); }
  function showFormError(form, error, notice = '#global-error') {
    clearFormErrors(form);
    const fields = { ...(error?.fields || {}) };
    const codeField = {
      INVALID_EMAIL: 'email', INVALID_PASSWORD: 'password', ADMIN_EXISTS: 'email',
      GAME_NOT_WHITELISTED: 'game', INVALID_FACT_PRICE: 'price',
    }[error?.code];
    if (!Object.keys(fields).length && codeField) fields[codeField] = error.code;
    let firstInvalid = null;
    for (const path of Object.keys(fields)) {
      const name = fieldNames[path] || path;
      const control = form.elements.namedItem(name);
      if (!control || typeof control.setAttribute !== 'function') continue;
      const label = control.labels?.[0] || control.closest('label');
      if (!label) continue;
      const fieldContainer = control.closest('.login-field') || label;
      const errorId = `${form.id || 'form'}-${name}-error`;
      const note = document.createElement('span');
      note.className = 'field-error';
      note.id = errorId;
      note.setAttribute('role', 'alert');
      note.textContent = `Periksa kembali ${fieldLabels[path] || name}.`;
      fieldContainer.append(note);
      control.dataset.errorId = errorId;
      control.setAttribute('aria-invalid', 'true');
      const hint = label.querySelector('.field-hint');
      if (hint && !hint.id) hint.id = `${form.id || 'form'}-${name}-hint`;
      const describedBy = [...new Set([control.getAttribute('aria-describedby'), hint?.id, errorId].filter(Boolean))].join(' ');
      control.setAttribute('aria-describedby', describedBy);
      firstInvalid ||= control;
    }
    show(notice, errorText(error));
    if (firstInvalid) {
      firstInvalid.focus({ preventScroll: true });
      firstInvalid.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }
  const onboardingLabels = {
    brand: 'Nama dan gaya komunikasi brand',
    games: 'Daftar game yang disetujui',
    guardrails: 'Batasan konten AI',
    links: 'Tautan top-up dan jual akun',
    hashtags: 'Hashtag otomatis',
    facts: 'Informasi harga dan stok produk',
    thread: 'Akun Threads testing',
    ai: 'Penyedia AI',
  };
  const onboardingTargets = {
    brand: { tab: 'content', field: 'brandName' },
    games: { tab: 'content', field: 'gameWhitelist' },
    guardrails: { tab: 'content', field: 'guardrailsApproved' },
    links: { tab: 'content', field: 'trackedTopup' },
    hashtags: { tab: 'content', field: 'hashtags' },
    facts: { tab: 'facts', field: 'game' },
    thread: { tab: 'integrations', field: 'profileId' },
    ai: { tab: 'ai', field: 'model' },
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
    if (!response.ok) {
      const error = new Error(payload.error || `Permintaan gagal (${response.status})`);
      error.code = payload.error;
      error.fields = payload.fields || {};
      error.status = response.status;
      error.retryAfterSeconds = parseRetryAfterSeconds(payload.retryAfterSeconds, response.headers?.get?.('Retry-After'));
      throw error;
    }
    return payload;
  }

  function clearLoginFeedback() {
    const message = $('#login-error').textContent;
    hide('#login-error');
    if (!message) return;
    $$('#toast-region .toast').forEach((toast) => {
      if (toast.querySelector('.toast-message')?.textContent !== message) return;
      clearTimeout(toastTimers.get(toast));
      toast.remove();
    });
  }

  function setAuthenticated(authenticated) {
    clearLoginFeedback();
    $('#login-view').hidden = authenticated;
    $('#app-view').hidden = !authenticated;
    const focusTarget = authenticated ? $('#dashboard-title') : $('#login-email');
    focusTarget?.focus({ preventScroll: true });
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
      brandName: brand.name, voice: brand.voice, contentDirection: brand.contentDirection, audienceNotes: brand.audienceNotes,
      gameWhitelist: (settings.gameWhitelist || []).join('\n'),
      hashtags: (settings.hashtags || []).join('\n'),
      trackedTopup: settings.trackedLinks?.topup || '', trackedAccount: settings.trackedLinks?.account || '',
      forbiddenClaims: (guardrails.forbiddenClaims || []).join('\n'),
      approvedClaims: (guardrails.approvedClaims || []).join('\n'),
      hookVocabulary: (guardrails.hookVocabulary || []).join('\n'),
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
      contentDirection: value($('#content-form'), 'contentDirection'), audienceNotes: value($('#content-form'), 'audienceNotes'), gameWhitelist: lines(value($('#content-form'), 'gameWhitelist')),
      trackedTopup: value($('#content-form'), 'trackedTopup'), trackedAccount: value($('#content-form'), 'trackedAccount'),
      forbiddenClaims: lines(value($('#content-form'), 'forbiddenClaims')), approvedClaims: lines(value($('#content-form'), 'approvedClaims')),
      hookVocabulary: lines(value($('#content-form'), 'hookVocabulary')),
    };
    if (category === 'topup') return { game: value($('#fact-topup-form'), 'game').trim(), denomination: value($('#fact-topup-form'), 'denomination').trim() };
    return { attributes: lines(value($('#fact-account-form'), 'attributes')) };
  }

  function savedGameWhitelist() { return state.data?.settings?.gameWhitelist || []; }

  function applyTemplate(template) {
    if (template.category === 'brand') {
      const data = template.data || {};
      setFormValues($('#content-form'), {
        brandName: data.brandName, voice: data.voice, contentDirection: data.contentDirection, audienceNotes: data.audienceNotes,
        gameWhitelist: (data.gameWhitelist || []).join('\n'), trackedTopup: data.trackedTopup, trackedAccount: data.trackedAccount,
        forbiddenClaims: (data.forbiddenClaims || []).join('\n'), approvedClaims: (data.approvedClaims || []).join('\n'), guardrailsApproved: false,
        hookVocabulary: (data.hookVocabulary || []).join('\n'),
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
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button danger'; remove.textContent = 'Hapus'; remove.addEventListener('click', async (event) => {
        if (!confirmAction(`Hapus template “${template.name}”?`)) return;
        await withPending(event.currentTarget, async () => {
          try { await api(`/api/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' }); show('#global-success', 'Template berhasil dihapus.'); await refreshAfterMutation(loadTemplates); }
          catch (error) { show('#global-error', errorText(error)); }
        }, 'Menghapus…');
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
    if (name === 'contentDirection') field.maxLength = 7000;
    if (name === 'hookVocabulary') field.maxLength = 7000;
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
      editorControl('Arahan konten AI', 'contentDirection', data.contentDirection, { multiline: true, hint: 'Acuan utama untuk topik dan sudut konten; tetap mengikuti batas AI.' }),
      editorControl('Wawasan pelanggan', 'audienceNotes', data.audienceNotes, { multiline: true }),
      editorControl('Game top-up dalam whitelist', 'gameWhitelist', data.gameWhitelist, { multiline: true, hint: 'Simpan hanya game yang sudah ada di whitelist.' }),
      editorControl('Kosakata hook yang disarankan', 'hookVocabulary', data.hookVocabulary, { multiline: true, hint: 'Opsional. Satu kata atau frasa per baris; hanya panduan, bukan allowlist.' }),
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
      brandName: val('brandName'), voice: val('voice'), contentDirection: val('contentDirection'), audienceNotes: val('audienceNotes'), gameWhitelist: lines(val('gameWhitelist')),
      trackedTopup: val('trackedTopup'), trackedAccount: val('trackedAccount'), forbiddenClaims: lines(val('forbiddenClaims')), approvedClaims: lines(val('approvedClaims')),
      hookVocabulary: lines(val('hookVocabulary')),
    };
    if (category === 'topup') return { game: val('game'), denomination: val('denomination') };
    return { attributes: lines(val('attributes')) };
  }

  function activateTab(name) {
    const button = $('.tab[data-tab="' + name + '"]');
    if (!button) return;
    $$('.tab').forEach((tab) => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });
    $$('.tab-panel').forEach((panel) => {
      const active = panel.id === 'tab-' + name;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    });
    button.scrollIntoView?.({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }

  const sidebar = $('#dashboard-sidebar');
  const sidebarToggle = $('#sidebar-toggle');
  const sidebarBackdrop = $('#sidebar-backdrop');
  const sidebarClose = $('#sidebar-close');
  const sidebarViewport = window.matchMedia('(max-width: 899px)');
  function setSidebarOpen(open, { restoreFocus = true, focusPanel = false } = {}) {
    if (!sidebarViewport.matches) return;
    sidebar.classList.toggle('is-open', open);
    sidebar.inert = !open;
    sidebar.setAttribute('aria-hidden', String(!open));
    sidebar.setAttribute('role', open ? 'dialog' : 'complementary');
    if (open) sidebar.setAttribute('aria-modal', 'true'); else sidebar.removeAttribute('aria-modal');
    sidebarToggle.setAttribute('aria-expanded', String(open));
    sidebarBackdrop.hidden = !open;
    document.body.classList.toggle('nav-open', open);
    if (open) $('.tab[aria-selected="true"]', sidebar).focus();
    else if (focusPanel) $('#tab-' + $('.tab[aria-selected="true"]', sidebar).dataset.tab).focus();
    else if (restoreFocus) sidebarToggle.focus();
  }
  function syncSidebarViewport() {
    if (sidebarViewport.matches) {
      const focusWasInSidebar = sidebar.contains(document.activeElement);
      setSidebarOpen(false, { restoreFocus: false });
      if (focusWasInSidebar) sidebarToggle.focus();
    }
    else {
      const focusWasOnMobileControl = document.activeElement === sidebarToggle
        || document.activeElement === sidebarClose || document.activeElement === sidebarBackdrop;
      sidebar.classList.remove('is-open'); sidebar.inert = false;
      sidebar.setAttribute('aria-hidden', 'false'); sidebar.setAttribute('role', 'complementary');
      sidebar.removeAttribute('aria-modal'); sidebarToggle.setAttribute('aria-expanded', 'false');
      sidebarBackdrop.hidden = true; document.body.classList.remove('nav-open');
      if (focusWasOnMobileControl) $('.tab[aria-selected="true"]', sidebar).focus();
    }
  }
  function loadTabData(name) {
    if (name === 'admins') loadAdmins().catch((error) => show('#global-error', errorText(error)));
    if (name === 'templates') loadTemplates().catch((error) => show('#global-error', errorText(error)));
    if (name === 'integrations' || name === 'ai') loadIntegrations().catch((error) => show('#global-error', integrationError(error)));
  }
  syncSidebarViewport();
  sidebarViewport.addEventListener?.('change', syncSidebarViewport);
  sidebarToggle.addEventListener('click', () => setSidebarOpen(true));
  sidebarClose.addEventListener('click', () => setSidebarOpen(false));
  sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
  document.addEventListener('keydown', (event) => {
    if (!sidebarViewport.matches || !sidebar.classList.contains('is-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); setSidebarOpen(false); return; }
    if (event.key !== 'Tab') return;
    const focusable = $$('button:not([disabled]):not([tabindex="-1"])', sidebar);
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  function setOnboardingLoadState(status) {
    const loading = $('#onboarding-loading');
    const error = $('#onboarding-error');
    const summary = $('#onboarding-summary');
    const incomplete = $('#onboarding-incomplete');
    const details = $('#onboarding-details');
    loading.hidden = status !== 'loading';
    error.hidden = status !== 'error';
    summary.hidden = true;
    incomplete.hidden = true;
    details.hidden = true;
    const badge = $('#onboarding-count');
    badge.textContent = status === 'loading' ? 'Memuat status' : 'Status tidak tersedia';
    badge.className = 'pill neutral';
  }

  function renderOnboarding(items) {
    if (!Array.isArray(items) || items.length === 0 || items.some((item) => !item || typeof item.required !== 'boolean' || typeof item.complete !== 'boolean')) {
      setOnboardingLoadState('error');
      return;
    }
    const list = $('#onboarding-list');
    const required = items.filter((item) => item.required);
    const completeRequired = required.filter((item) => item.complete).length;
    const missing = required.length - completeRequired;
    const complete = required.length > 0 && missing === 0;
    const sortedItems = [...items].sort((a, b) => {
      const rank = (item) => item.required ? item.complete ? 1 : 0 : item.complete ? 3 : 2;
      return rank(a) - rank(b);
    });
    list.replaceChildren(...sortedItems.map((item) => {
      const li = document.createElement('li');
      if (!item.complete) li.classList.add('incomplete');
      if (item.required === false) li.classList.add('optional');
      else li.classList.add('required');
      const heading = document.createElement('div');
      heading.className = 'onboarding-item-heading';
      const icon = document.createElement('span');
      icon.className = `onboarding-item-icon ${item.complete ? 'complete' : 'incomplete'}`;
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.complete ? '✓' : '!';
      const text = document.createElement('span');
      text.className = 'onboarding-label';
      text.textContent = onboardingLabels[item.key] || item.label || item.key || 'Persiapan awal';
      heading.append(icon, text);
      const footer = document.createElement('div');
      footer.className = 'onboarding-item-footer';
      const status = document.createElement('span');
      status.className = `onboarding-item-status ${item.complete ? 'complete' : 'incomplete'}`;
      status.textContent = `${item.required ? 'Wajib' : 'Opsional'} · ${item.complete ? 'Selesai' : item.required ? 'Belum selesai' : 'Perlu diisi'}`;
      footer.append(status);
      const target = onboardingTargets[item.key];
      if (!item.complete && target) {
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'onboarding-action';
        action.dataset.onboardingTarget = item.key;
        action.textContent = target.field ? 'Buka pengaturan' : 'Lihat status';
        action.addEventListener('click', () => {
          activateTab(target.tab);
          loadTabData(target.tab);
          const form = target.field ? $('#tab-' + target.tab + ' form') : null;
          const focusTarget = target.field ? form?.elements.namedItem(target.field) : document.getElementById(target.element);
          focusTarget?.focus({ preventScroll: true });
          focusTarget?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        });
        footer.append(action);
      }
      li.append(heading, footer);
      return li;
    }));
    const loading = $('#onboarding-loading'); loading.hidden = true;
    const error = $('#onboarding-error'); error.hidden = true;
    const summary = $('#onboarding-summary'); summary.hidden = !complete;
    const incomplete = $('#onboarding-incomplete'); incomplete.hidden = complete;
    const details = $('#onboarding-details');
    const badge = $('#onboarding-count');
    badge.textContent = complete ? 'Wajib lengkap' : `${missing} wajib tersisa`;
    badge.className = `pill ${complete ? 'good' : 'warning'}`;
    $('#onboarding-progress').textContent = `${completeRequired} dari ${required.length} konfigurasi wajib selesai.`;
    if (complete && state.onboardingComplete !== true) state.onboardingExpanded = false;
    if (!complete) state.onboardingExpanded = false;
    if (state.onboardingComplete !== complete) {
      $('#onboarding-announcement').textContent = complete
        ? `Konfigurasi wajib lengkap: ${completeRequired} dari ${required.length} item selesai.`
        : state.onboardingComplete === true
          ? 'Onboarding kembali belum lengkap. Periksa item wajib yang perlu diperbaiki.'
          : `Onboarding belum lengkap. ${missing} dari ${required.length} item wajib masih perlu disiapkan.`;
    }
    state.onboardingComplete = complete;
    details.hidden = complete && !state.onboardingExpanded;
    const toggle = $('#onboarding-details-toggle');
    toggle.hidden = !complete;
    toggle.setAttribute('aria-expanded', String(complete && state.onboardingExpanded));
    toggle.textContent = state.onboardingExpanded ? 'Sembunyikan detail' : 'Lihat detail';
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
    $('#automation-reason').textContent = automation.enabled ? 'Tugas berjalan sesuai jadwal.' : 'Lengkapi nama dan gaya komunikasi brand, hubungkan akun Threads testing di Tebar, dan konfigurasi penyedia AI.';
    const dot = $('#automation-state'); dot.className = `state-dot ${automation.enabled ? 'on' : automation.paused ? 'paused' : 'off'}`;
    const control = $('#automation-button'); control.textContent = automation.enabled ? 'Jeda darurat' : 'Aktifkan otomasi'; control.className = `button ${automation.enabled ? 'danger' : 'primary'}`;
    const provider = data.provider || {};
    $('#provider-status').textContent = provider.connected ? (provider.status || 'Terhubung') : 'Belum terhubung';
    $('#provider-account').textContent = provider.username ? `@${provider.username}` : 'Hubungkan melalui Tebar';
    $('#metric-success').textContent = String(data.metrics?.success30d ?? 0);
    $('#metric-clicks').textContent = data.metrics?.clicks?.available ? String(data.metrics.clicks.value) : 'Belum tersedia';
    $('#metric-failed').textContent = String(data.metrics?.attention ?? 0);
    $('#metric-facts').textContent = `${data.metrics?.freshFacts ?? 0} / 2`;
    renderOnboarding(data.onboarding); renderPosts(data.posts || []); renderActivity(data.activity || []); readSettings();
  }

  async function refresh() {
    const request = state.dashboardLoad = (state.dashboardLoad || 0) + 1;
    setOnboardingLoadState('loading');
    try {
      const data = await api('/api/dashboard');
      if (request !== state.dashboardLoad) return false;
      render(data);
      hide('#global-error');
      return true;
    } catch (error) {
      if (request === state.dashboardLoad) setOnboardingLoadState('error');
      throw error;
    }
  }

  function integrationVersion() {
    const version = state.integrations?.configuration?.version;
    if (version === undefined || version === null) { const error = new Error('CONFIG_NOT_LOADED'); error.code = 'CONFIG_NOT_LOADED'; throw error; }
    return version;
  }
  function integrationError(error) {
    if (error?.code === 'CONFIG_NOT_LOADED') return 'Muat ulang konfigurasi sebelum melanjutkan.';
    return errorText(error);
  }
  function showIntegrationOutcome(configuration, successMessage) {
    hide('#global-error'); hide('#global-success');
    const status = String(configuration?.status || '').toUpperCase();
    if (status === 'BLOCKED_RECONCILIATION' || status === 'SWITCHING') {
      show('#global-error', 'Pergantian akun belum selesai. Periksa status post lama dan lanjutkan rekonsiliasi.');
    } else if (status === 'NOT_CONFIGURED') {
      show('#global-error', 'Pengaturan tersimpan, tetapi konfigurasi integrasi belum lengkap. Lengkapi akun dan model sebelum mengaktifkan otomasi.');
    } else if (status === 'ACTIVE') show('#global-success', successMessage);
    else show('#global-error', 'Status konfigurasi belum dapat dipastikan. Muat ulang dan periksa sebelum melanjutkan.');
  }
  async function finishIntegrationMutation(configuration, successMessage, updateDashboard = false) {
    try { if (!await loadIntegrations()) return; }
    catch {
      show('#global-error', 'Permintaan perubahan diterima, tetapi status terkini belum tersedia. Muat ulang konfigurasi sebelum melanjutkan.');
      return;
    }
    const dashboardError = updateDashboard && await refresh().catch(() => true);
    showIntegrationOutcome(state.integrations?.configuration || configuration, successMessage);
    if (dashboardError) {
      const error = $('#global-error');
      show('#global-error', `${error.hidden ? '' : error.textContent + ' '}Ringkasan dashboard belum dapat diperbarui.`);
    }
  }
  function renderIntegrationHistory(history = [], component = 'account') {
    const container = $(`#integration-${component}-history`);
    container.replaceChildren();
    const relevant = history.filter((item) => {
      const action = String(item.action || '');
      return action === 'bootstrap' || action.startsWith(`${component}_`) || (component === 'account' && action.startsWith('switch_'));
    });
    if (!relevant.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Belum ada riwayat konfigurasi.'; container.append(empty); return;
    }
    relevant.forEach((item) => {
      const row = document.createElement('article'); row.className = 'integration-history-item';
      const title = document.createElement('strong'); title.textContent = `Versi ${item.version ?? '—'} · ${item.action || 'Perubahan'}`;
      const details = document.createElement('p');
      const date = item.createdAt ? new Date(item.createdAt) : null;
      const dateText = date && Number.isFinite(date.getTime()) ? date.toLocaleString('id-ID') : 'Waktu tidak tersedia';
      const actor = item.actorEmail || item.actorId || 'sistem';
      details.textContent = component === 'account'
        ? `${dateText} · Admin ${actor} · ${item.status || '—'} · Profile ${item.profileId || '—'} · Akun ${item.accountId || '—'}`
        : `${dateText} · Admin ${actor} · ${item.status || '—'} · Model ${item.model || '—'}`;
      const actions = document.createElement('div'); actions.className = 'form-actions';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button quiet';
      button.textContent = component === 'account' ? 'Pulihkan akun' : 'Pulihkan model';
      const restorable = ['ACTIVE', 'NOT_CONFIGURED'].includes(item.status);
      button.disabled = !restorable || (component === 'account' ? !item.profileId || !item.accountId : !item.model);
      if (!restorable) button.title = 'Versi yang masih menunggu rekonsiliasi tidak dapat dipulihkan.';
      button.addEventListener('click', async () => {
          hide('#global-error'); hide('#global-success');
          try {
            await withPending(button, async () => {
              const expectedVersion = integrationVersion();
              const current = state.integrations?.configuration || {};
              let summary;
              if (component === 'account') {
                const checked = await api('/api/integrations/validate-account', { method: 'POST', body: JSON.stringify({ profileId: item.profileId, accountId: item.accountId }) });
                const accountName = checked.account?.username ? `@${checked.account.username} (${item.accountId})` : item.accountId;
                summary = `Pulihkan akun ke ${accountName}? Model tetap ${current.model || 'belum dikonfigurasi'}. Otomasi akan dijeda dan post lama diperiksa.`;
              } else {
                await api('/api/integrations/validate-model', { method: 'POST', body: JSON.stringify({ model: item.model }) });
                summary = `Pulihkan model ke ${item.model}? Akun tetap ${current.accountId || 'belum dikonfigurasi'}.`;
              }
              if (!confirmAction(`${summary} Versi referensi: ${item.version}.`)) return;
              const result = await api('/api/integrations/rollback', { method: 'POST', body: JSON.stringify({ version: item.version, expectedVersion, confirmed: true, component }) });
              await finishIntegrationMutation(result.configuration, component === 'account' ? 'Akun berhasil dipulihkan. Aktifkan otomasi kembali secara manual.' : 'Model berhasil dipulihkan.', true);
            }, 'Memeriksa…');
          } catch (error) { show('#global-error', integrationError(error)); }
      });
      actions.append(button);
      row.append(title, details, actions); container.append(row);
    });
  }
  function syncIntegrationControls() {
    for (const selector of ['#integration-account-form', '#integration-model-form']) {
      const form = $(selector);
      $('button[type="submit"]', form).disabled = !state.integrations || form.dataset.pending === 'true';
    }
  }
  async function loadIntegrations({ verification = null } = {}) {
    const request = state.integrationLoad = (state.integrationLoad || 0) + 1;
    state.integrations = null;
    state.integrationVerification = null;
    syncIntegrationControls();
    hide('#integration-account-preview');
    for (const selector of ['#integration-active-profile', '#integration-active-account', '#integration-provider-status', '#integration-switch-status', '#ai-active-model']) $(selector).textContent = 'Tidak tersedia';
    $('#integration-check-active').disabled = true;
    $('#integration-reconcile').hidden = true;
    $('#integration-notice').textContent = 'Memuat konfigurasi terkini. Isian perubahan tetap disimpan.';
    $('#ai-notice').textContent = 'Memuat model aktif dari konfigurasi server.';
    renderIntegrationHistory([], 'account');
    renderIntegrationHistory([], 'model');
    let result;
    try {
      result = await api('/api/integrations');
    } catch (error) {
      if (request !== state.integrationLoad) return false;
      $('#integration-notice').textContent = 'Konfigurasi tidak tersedia. Muat ulang sebelum menyimpan perubahan.';
      $('#ai-notice').textContent = 'Model aktif belum dapat dimuat. Coba muat ulang sebelum menyimpan perubahan.';
      throw error;
    }
    if (request !== state.integrationLoad) return false;
    const configuration = result.configuration || {};
    state.integrations = result;
    syncIntegrationControls();
    state.integrationVerification = verification;
    $('#integration-active-profile').textContent = configuration.profileId || 'Belum dikonfigurasi';
    const verifiedAccount = verification?.profileId === configuration.profileId && verification?.accountId === configuration.accountId ? verification.account : null;
    $('#integration-active-account').textContent = `${configuration.accountId || 'Belum dikonfigurasi'}${verifiedAccount?.username ? ` · @${verifiedAccount.username}` : ''}`;
    $('#integration-provider-status').textContent = verifiedAccount ? `Terverifikasi · ${verifiedAccount.platform || 'Threads'} · ${verifiedAccount.status || 'status tidak diketahui'}` : 'Belum diverifikasi pada halaman ini';
    $('#integration-check-active').disabled = !configuration.profileId || !configuration.accountId;
    $('#ai-active-model').textContent = configuration.model || 'Belum dikonfigurasi';
    $('#ai-notice').textContent = configuration.model ? 'Model aktif dibaca dari konfigurasi server.' : 'Belum ada model yang dikonfigurasi.';
    const status = String(configuration.status || 'NOT_CONFIGURED').toUpperCase();
    const labels = { ACTIVE: 'Aktif', PAUSED: 'Dijeda', SWITCHING: 'Pergantian berlangsung', BLOCKED_RECONCILIATION: 'Tertahan: post lama perlu diperiksa', NOT_CONFIGURED: 'Belum dikonfigurasi' };
    $('#integration-switch-status').textContent = labels[status] || status;
    const pending = configuration.pendingProfileId || configuration.pendingAccountId;
    $('#integration-notice').textContent = pending ? `Pergantian menunggu pemeriksaan: profile ${configuration.pendingProfileId || '—'}, akun ${configuration.pendingAccountId || '—'}. Otomasi tetap dijeda.` : 'Perubahan akun dapat menjeda otomasi. Periksa status sebelum mengaktifkannya kembali.';
    $('#integration-reconcile').hidden = !['SWITCHING', 'BLOCKED_RECONCILIATION'].includes(status);
    const accountForm = $('#integration-account-form');
    const oldAccount = accountForm.dataset.baseline && JSON.parse(accountForm.dataset.baseline);
    if ((!oldAccount && !accountForm.elements.profileId.value && !accountForm.elements.accountId.value) || (oldAccount && accountForm.elements.profileId.value === oldAccount.profileId && accountForm.elements.accountId.value === oldAccount.accountId)) {
      accountForm.elements.profileId.value = configuration.profileId || '';
      accountForm.elements.accountId.value = configuration.accountId || '';
    }
    accountForm.dataset.baseline = JSON.stringify({ profileId: configuration.profileId || '', accountId: configuration.accountId || '' });
    const modelForm = $('#integration-model-form');
    if ((modelForm.dataset.baseline === undefined && !modelForm.elements.model.value) || modelForm.elements.model.value === modelForm.dataset.baseline) modelForm.elements.model.value = configuration.model || '';
    modelForm.dataset.baseline = configuration.model || '';
    const history = Array.isArray(result.history) ? result.history : [];
    renderIntegrationHistory(history, 'account');
    renderIntegrationHistory(history, 'model');
    return true;
  }

  $('#integration-account-form').addEventListener('input', () => hide('#integration-account-preview'));
  $('#integration-account-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; hide('#global-error'); hide('#global-success'); hide('#integration-account-error'); hide('#integration-account-preview'); clearFormErrors(form);
    const payload = { profileId: value(form, 'profileId').trim(), accountId: value(form, 'accountId').trim() };
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        const version = integrationVersion();
        const checked = await api('/api/integrations/validate-account', { method: 'POST', body: JSON.stringify(payload) });
        const account = checked.account || {};
        const identity = account.username ? `@${account.username}` : account.id || payload.accountId;
        show('#integration-account-preview', `Akun terverifikasi: ${identity} · Profile ${account.profileId || payload.profileId} · Platform ${account.platform || 'Threads'} · Status ${account.status || 'tidak diketahui'}.`);
        if (!confirmAction(`Ganti tujuan posting ke ${identity} (Account ID ${payload.accountId}) di profile ${payload.profileId}? Otomasi akan dijeda dan post lama diperiksa.`)) return;
        const result = await api('/api/integrations/account', { method: 'PUT', body: JSON.stringify({ ...payload, expectedVersion: version, confirmed: true }) });
        if (result.configuration?.status === 'ACTIVE') form.dataset.baseline = JSON.stringify(payload);
        await finishIntegrationMutation(result.configuration, 'Akun berhasil diganti. Otomasi tetap nonaktif sampai diaktifkan kembali.', true);
      }, 'Memeriksa…', form);
    } catch (error) {
      if (['INVALID_ACCOUNT', 'ACCOUNT_NOT_AVAILABLE'].includes(error.code)) error.fields = { profileId: error.code, accountId: error.code };
      showFormError(form, error, '#integration-account-error');
    }
  });
  $('#integration-model-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; hide('#global-error'); hide('#global-success'); hide('#integration-model-error'); clearFormErrors(form);
    const model = value(form, 'model').trim();
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        const expectedVersion = integrationVersion();
        const checked = await api('/api/integrations/validate-model', { method: 'POST', body: JSON.stringify({ model }) });
        const identity = checked.model?.name || checked.model?.id || model;
        if (!confirmAction(`Gunakan model ${identity} (${model}) untuk generasi berikutnya?`)) return;
        const result = await api('/api/integrations/model', { method: 'PUT', body: JSON.stringify({ model, expectedVersion }) });
        form.dataset.baseline = model;
        await finishIntegrationMutation(result.configuration, 'Model AI berhasil diperbarui untuk generasi berikutnya.', true);
      }, 'Memeriksa…', form);
    } catch (error) {
      if (['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE'].includes(error.code)) error.fields = { model: error.code };
      showFormError(form, error, '#integration-model-error');
    }
  });
  $('#integration-model-catalog').addEventListener('click', async (event) => {
    try {
      await withPending(event.currentTarget, async () => {
        const result = await api('/api/integrations/models');
        const list = $('#integration-model-list'); list.replaceChildren();
        (Array.isArray(result.models) ? result.models : []).forEach((model) => {
          if (typeof model.id !== 'string') return;
          const option = document.createElement('option'); option.value = model.id; option.label = model.name || model.id; list.append(option);
        });
        $('#integration-model-catalog-status').textContent = list.children.length ? `${list.children.length} model tersedia. Anda juga dapat memasukkan ID secara manual.` : 'Daftar kosong; masukkan model ID secara manual.';
      }, 'Memuat…', null);
    } catch (error) { $('#integration-model-catalog-status').textContent = 'Daftar model tidak tersedia; masukkan model ID secara manual.'; show('#integration-model-error', integrationError(error)); }
  });
  $('#integration-refresh').addEventListener('click', (event) => withPending(event.currentTarget, () => loadIntegrations(), 'Memuat…').catch((error) => show('#global-error', integrationError(error))));
  $('#ai-refresh').addEventListener('click', (event) => withPending(event.currentTarget, () => loadIntegrations(), 'Memuat…').catch((error) => show('#global-error', integrationError(error))));
  $('#integration-check-active').addEventListener('click', async (event) => {
    const checkLoad = state.integrationLoad;
    try {
      await withPending(event.currentTarget, async () => {
        const { profileId, accountId } = state.integrations?.configuration || {};
        if (!profileId || !accountId) { const error = new Error('CONFIG_NOT_LOADED'); error.code = 'CONFIG_NOT_LOADED'; throw error; }
        state.integrationVerification = null;
        $('#integration-active-account').textContent = accountId;
        $('#integration-provider-status').textContent = 'Memeriksa akun…';
        const result = await api('/api/integrations/validate-account', { method: 'POST', body: JSON.stringify({ profileId, accountId }) });
        if (checkLoad !== state.integrationLoad) return;
        await loadIntegrations({ verification: { profileId, accountId, account: result.account || {} } });
      }, 'Memeriksa…');
    } catch (error) { if (checkLoad !== state.integrationLoad) return; state.integrationVerification = null; $('#integration-provider-status').textContent = 'Pemeriksaan gagal'; show('#global-error', integrationError(error)); }
  });
  $('#integration-reconcile').addEventListener('click', async (event) => {
    hide('#global-error'); hide('#global-success');
    try {
      await withPending(event.currentTarget, async () => {
        const result = await api('/api/integrations/reconcile', { method: 'POST', body: JSON.stringify({ expectedVersion: integrationVersion() }) });
        await finishIntegrationMutation(result.configuration, 'Pergantian akun selesai. Otomasi tetap nonaktif sampai diaktifkan kembali.', true);
      }, 'Memeriksa…');
    } catch (error) { show('#global-error', integrationError(error)); }
  });

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearFormErrors(form); hide('#login-error');
    const button = event.submitter || $('button[type="submit"]', form);
    const loginPayload = { email: value(form, 'email'), password: value(form, 'password') };
    try {
      await withPending(button, async () => {
        const result = await api('/api/session/login', { method: 'POST', body: JSON.stringify(loginPayload) });
        state.csrf = result.csrfToken || '';
        setAuthenticated(true);
        try { await refresh(); }
        catch (error) { show('#global-error', errorText(error)); }
      }, 'Memeriksa…', form);
    } catch (error) { showFormError(form, error, '#login-error'); }
  });

  $('#logout-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    await withPending(button, async () => {
      let logoutError = null;
      try { await api('/api/session/logout', { method: 'POST', body: '{}' }); }
      catch (error) { logoutError = error; }
      finally { state.csrf = ''; state.integrations = null; state.integrationVerification = null; state.integrationLoad = (state.integrationLoad || 0) + 1; state.dashboardLoad += 1; state.data = null; state.onboardingComplete = null; state.onboardingExpanded = false; syncIntegrationControls(); $('#integration-check-active').disabled = true; $('#integration-reconcile').hidden = true; for (const selector of ['#integration-active-profile', '#integration-active-account', '#integration-provider-status', '#integration-switch-status', '#ai-active-model']) $(selector).textContent = 'Tidak tersedia'; renderIntegrationHistory([], 'account'); renderIntegrationHistory([], 'model'); hide('#integration-account-preview'); $('#integration-account-form').reset(); $('#integration-model-form').reset(); delete $('#integration-account-form').dataset.baseline; delete $('#integration-model-form').dataset.baseline; setAuthenticated(false); }
      if (logoutError) show('#login-error', 'Sesi dashboard ditutup. Server belum mengonfirmasi proses keluar; masuk kembali untuk memperbarui sesi. ' + errorText(logoutError));
    }, 'Keluar…');
  });

  $('#admin-create-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    clearFormErrors(form);
    const adminPayload = { email: value(form, 'email'), password: value(form, 'password') };
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        await api('/api/admins', { method: 'POST', body: JSON.stringify(adminPayload) });
        form.reset(); show('#global-success', 'Akun admin berhasil ditambahkan.'); await refreshAfterMutation(loadAdmins);
      }, 'Menambahkan…', form);
    } catch (error) { showFormError(form, error); }
  });
  $('#admin-list').addEventListener('submit', async (event) => {
    const form = event.target.closest('form[data-admin-id]'); if (!form) return;
    event.preventDefault();
    const changes = {}; const email = value(form, 'email'); if (email !== form.dataset.originalEmail) changes.email = email; const password = value(form, 'password'); if (password) changes.password = password;
    if (!Object.keys(changes).length) { show('#global-success', 'Tidak ada perubahan untuk disimpan.'); return; }
    clearFormErrors(form);
    const button = event.submitter || $('button[type="submit"]', form);
    try {
      await withPending(button, async () => {
        const result = await api(`/api/admins/${form.dataset.adminId}`, { method: 'PATCH', body: JSON.stringify(changes) });
        if (result.sessionRevoked) { state.csrf = ''; setAuthenticated(false); show('#login-error', 'Akun diperbarui. Masuk kembali dengan email atau kata sandi baru.'); return; }
        show('#global-success', 'Perubahan akun admin berhasil disimpan.'); await refreshAfterMutation(loadAdmins);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  });
  $('#admin-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-active]'); if (!button) return;
    const form = button.closest('form[data-admin-id]'); const active = button.dataset.active !== 'true';
    if (!active && !confirmAction('Nonaktifkan akun ini? Semua sesi login akun akan dihentikan.')) return;
    await withPending(button, async () => {
      try { await api(`/api/admins/${form.dataset.adminId}`, { method: 'PATCH', body: JSON.stringify({ active }) }); show('#global-success', active ? 'Akun admin diaktifkan kembali.' : 'Akun admin dinonaktifkan.'); await refreshAfterMutation(loadAdmins); }
      catch (error) { show('#global-error', errorText(error)); }
    }, 'Memproses…', form);
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
    clearFormErrors(form);
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        if (templateDialogState.mode === 'edit') await api(`/api/templates/${encodeURIComponent(templateDialogState.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        else await api('/api/templates', { method: 'POST', body: JSON.stringify({ ...payload, category: templateDialogState.category }) });
        $('#template-dialog').close(); show('#global-success', templateDialogState.mode === 'edit' ? 'Template diperbarui.' : 'Template disimpan dan dibagikan kepada semua admin.'); await refreshAfterMutation(loadTemplates);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error, '#template-dialog-error'); }
  });

  $('#content-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; clearFormErrors(form);
    const settings = state.data.settings || {};
    settings.brand = { name: value(form, 'brandName'), voice: value(form, 'voice'), contentDirection: value(form, 'contentDirection'), audienceNotes: value(form, 'audienceNotes') };
    settings.gameWhitelist = lines(value(form, 'gameWhitelist'));
    settings.hashtags = lines(value(form, 'hashtags'));
    settings.trackedLinks = { ...(settings.trackedLinks || {}), topup: value(form, 'trackedTopup'), account: value(form, 'trackedAccount') };
    settings.guardrails = { ...(settings.guardrails || {}), approved: form.elements.guardrailsApproved.checked, forbiddenClaims: lines(value(form, 'forbiddenClaims')), approvedClaims: lines(value(form, 'approvedClaims')), hookVocabulary: lines(value(form, 'hookVocabulary')) };
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
        show('#global-success', 'Panduan merek berhasil disimpan.'); await refreshAfterMutation(refresh);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  });

  $('#schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; clearFormErrors(form); const settings = state.data.settings || {};
    settings.schedule = { intervalHours: Number(value(form, 'intervalHours')) };
    settings.priceMode = value(form, 'priceMode');
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
        show('#global-success', 'Jadwal berhasil disimpan.'); await refreshAfterMutation(refresh);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  });

  $$('.fact-form').forEach((form) => form.addEventListener('submit', async (event) => {
    event.preventDefault(); clearFormErrors(form); const service = form.dataset.service;
    const summary = service === 'topup'
      ? { game: value(form, 'game'), denomination: value(form, 'denomination'), price: value(form, 'price'), availability: value(form, 'availability') }
      : { game: 'Mobile Legends', price: value(form, 'price'), availability: value(form, 'availability'), attributes: lines(value(form, 'attributes')) };
    Object.keys(summary).forEach((key) => { if (!summary[key] || (Array.isArray(summary[key]) && !summary[key].length)) delete summary[key]; });
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        await api(`/api/facts/${service}`, { method: 'PUT', body: JSON.stringify({ summary, active: true }) });
        show('#global-success', 'Informasi produk berhasil disimpan.'); await refreshAfterMutation(refresh);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  }));

  $('#automation-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const enabled = state.data?.automation?.enabled === true;
    if (!enabled && !confirmAction('Aktifkan penerbitan otomatis untuk workspace yang sedang terhubung? Sistem akan langsung memproses utas pertama, lalu menerbitkan berdasarkan interval yang tersimpan.')) return;
    await withPending(button, async () => {
      try {
        if (enabled) {
          const result = await api('/api/automation/pause', { method: 'POST', body: '{}' });
          show('#global-success', result.message || 'Otomasi dijeda.');
        } else {
          const result = await api('/api/automation/enable', { method: 'POST', body: '{}' });
          const firstPostAt = result.firstPostAt ? new Date(result.firstPostAt).toLocaleString('id-ID', { timeZone: 'Asia/Kuala_Lumpur' }) : null;
          show('#global-success', result.immediate
            ? 'Otomasi aktif. Utas pertama sedang diproses.'
            : `Otomasi aktif. Posting pertama dijadwalkan pada ${firstPostAt || 'setelah jeda minimum satu jam'}.`);
        }
        await refreshAfterMutation(refresh);
      } catch (error) { show('#global-error', errorText(error)); }
    }, 'Memproses…');
  });

  $('#refresh-button').addEventListener('click', () => refresh().catch((error) => show('#global-error', errorText(error))));
  $$('.sidebar-nav .tab').forEach((button) => button.addEventListener('click', () => {
    activateTab(button.dataset.tab);
    if (sidebarViewport.matches && sidebar.classList.contains('is-open')) setSidebarOpen(false, { restoreFocus: false, focusPanel: true });
    loadTabData(button.dataset.tab);
  }));
  $('#onboarding-details-toggle').addEventListener('click', (event) => {
    state.onboardingExpanded = !state.onboardingExpanded;
    $('#onboarding-details').hidden = !state.onboardingExpanded;
    event.currentTarget.setAttribute('aria-expanded', String(state.onboardingExpanded));
    event.currentTarget.textContent = state.onboardingExpanded ? 'Sembunyikan detail' : 'Lihat detail';
  });
  $('#onboarding-settings').addEventListener('click', () => {
    activateTab('content');
    loadTabData('content');
    const setting = $('#content-form').elements.namedItem('brandName');
    setting?.focus({ preventScroll: true });
    setting?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  });
  $('#onboarding-retry').addEventListener('click', (event) => {
    const pending = withPending(event.currentTarget, refresh, 'Memuat…').catch(() => false);
    $('#onboarding-loading').focus({ preventScroll: true });
    return pending;
  });
  $('.sidebar-nav').addEventListener('keydown', (event) => {
    const tabs = $$('.sidebar-nav .tab');
    const currentIndex = tabs.indexOf(event.target.closest('.tab'));
    if (currentIndex < 0) return;
    let nextIndex = currentIndex;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    const next = tabs[nextIndex];
    activateTab(next.dataset.tab);
    next.focus();
    loadTabData(next.dataset.tab);
  });
  document.addEventListener('input', (event) => {
    if (event.target?.closest('form')) clearFieldError(event.target);
  });

  renderBuiltinTemplates();
  $$('input[type="password"]').forEach(addPasswordToggle);
  api('/api/session').then((data) => {
    if (!data.authenticated) { setAuthenticated(false); return; }
    state.csrf = data.csrfToken || ''; setAuthenticated(true); return refresh();
  }).catch(() => setAuthenticated(false));
})();
