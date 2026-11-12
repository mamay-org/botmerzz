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
  function searchOpenRouterModels(models, query, limit = 50) {
    const term = String(query || '').trim().toLocaleLowerCase();
    if (!Array.isArray(models)) return [];
    const matches = models.filter((model) => [model?.name, model?.provider, model?.id]
      .some((value) => String(value || '').toLocaleLowerCase().includes(term)));
    return matches.slice(0, Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 50)));
  }
  function modelValidationStatusFromError(error) {
    if (error?.code === 'MODEL_NOT_FOUND') return 'NOT_FOUND';
    if (['INVALID_MODEL', 'MODEL_INCOMPATIBLE'].includes(error?.code)) return 'INCOMPATIBLE';
    return 'UNVERIFIED';
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
    module.exports = { withPending, parseRetryAfterSeconds, formatLoginWait, searchOpenRouterModels, modelValidationStatusFromError };
    return;
  }
  if (typeof document === 'undefined') return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = { csrf: '', data: null, templates: [], integrations: null, integrationVerification: null, modelCatalog: null, modelCatalogRequest: 0, modelSelection: null, modelValidation: null, modelDraftDirty: false, modelOptionMatches: [], modelActiveOption: -1, dashboardLoad: 0, onboardingComplete: null, onboardingExpanded: false, learningCapabilities: null };
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
    MODEL_METADATA_UNVERIFIED: 'Metadata model belum cukup untuk memastikan kompatibilitas. Model aktif tidak berubah.',
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
    'schedule.hours': 'jam interval posting', 'schedule.minutes': 'menit interval posting', 'schedule.intervalMinutes': 'interval posting', 'schedule.intervalHours': 'interval posting', 'schedule.timezone': 'zona waktu', priceMode: 'mode harga/stok',
    'summary.game': 'game', 'summary.denomination': 'nominal top-up', 'summary.price': 'harga',
    'summary.availability': 'ketersediaan', 'summary.attributes': 'atribut akun',
    email: 'email', password: 'kata sandi', game: 'game', price: 'harga',
    profileId: 'Profile ID', accountId: 'Account ID', model: 'model ID', modelSearch: 'model AI',
  };
  const fieldNames = {
    'brand.name': 'brandName', 'brand.voice': 'voice', 'brand.contentDirection': 'contentDirection',
    'brand.audienceNotes': 'audienceNotes', 'guardrails.approved': 'guardrailsApproved',
    'guardrails.forbiddenClaims': 'forbiddenClaims', 'guardrails.approvedClaims': 'approvedClaims',
    'guardrails.hookVocabulary': 'hookVocabulary', 'trackedLinks.topup': 'trackedTopup',
    'trackedLinks.account': 'trackedAccount', 'schedule.hours': 'hours', 'schedule.minutes': 'minutes', 'schedule.intervalMinutes': 'minutes', 'schedule.intervalHours': 'hours',
    'schedule.timezone': 'timezone', priceMode: 'priceMode', 'summary.game': 'game',
    'summary.denomination': 'denomination', 'summary.price': 'price',
    'summary.availability': 'availability', 'summary.attributes': 'attributes',
  };
  const errorText = (error) => {
    const code = error?.code || error?.message;
    if (code === 'LOGIN_RATE_LIMITED') return formatLoginWait(error.retryAfterSeconds);
    if (errors[code]) return errors[code];
    if (code === 'ACTIVATION_UNAVAILABLE') return 'Aktivasi belum tersedia karena pemeriksaan konflik belum siap.';
    if (code === 'RULE_CONFLICT' && Array.isArray(error.conflicts) && error.conflicts.length) {
      return `Aktivasi disekat: ${error.conflicts.map((item) => `${activationConflictLabel(item.code)}${item.ruleId ? ` (aturan ${item.ruleId})` : ''}`).join(', ')}.`;
    }
    if (code === 'FEEDBACK_ALREADY_EXISTS') return 'Anda sudah menilai versi konten ini.';
    if (code === 'CAPTION_NOT_FOUND') return 'Konten untuk ID slot ini tidak ditemukan.';
    if (code === 'DUPLICATE_RULE') return 'Instruksi dan lingkup tersebut sudah ada.';
    if (code === 'REVIEW_CONFLICT') return 'Data telah berubah. Muat ulang sebelum melanjutkan.';
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
      error.conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
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

  function updateScheduleIntervalSummary() {
    const form = $('#schedule-form');
    const summary = $('#schedule-interval-summary');
    if (!form || !summary) return;
    const rawHours = value(form, 'hours').trim();
    const rawMinutes = value(form, 'minutes').trim();
    if (!/^\d+$/u.test(rawHours) || !/^\d+$/u.test(rawMinutes)) {
      summary.textContent = 'Masukkan jam dan menit sebagai bilangan bulat non-negatif.';
      return;
    }
    const hours = Number(rawHours); const minutes = Number(rawMinutes); const total = hours * 60 + minutes;
    if (!Number.isSafeInteger(hours) || !Number.isSafeInteger(minutes) || minutes > 59 || !Number.isSafeInteger(total) || total < 1) {
      summary.textContent = 'Interval minimal 1 menit; nilai menit harus antara 0 dan 59.';
      return;
    }
    const parts = [];
    if (hours) parts.push(`${hours} jam`);
    if (minutes) parts.push(`${minutes} menit`);
    summary.textContent = `Interval yang akan disimpan: ${parts.join(' ')}.`;
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
    const legacyHours = typeof schedule.intervalHours === 'string' && /^\d+$/u.test(schedule.intervalHours)
      ? Number(schedule.intervalHours) : schedule.intervalHours;
    const savedIntervalMinutes = Number.isSafeInteger(schedule.intervalMinutes) && schedule.intervalMinutes > 0
      ? schedule.intervalMinutes
      : Number.isSafeInteger(legacyHours) && legacyHours >= 1 && Number.isSafeInteger(legacyHours * 60) ? legacyHours * 60 : 60;
    setFormValues($('#schedule-form'), {
      hours: Math.floor(savedIntervalMinutes / 60),
      minutes: savedIntervalMinutes % 60,
      priceMode: settings.priceMode || 'OFF',
    });
    updateScheduleIntervalSummary();
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
      editorControl('Kosakata hook yang disarankan', 'hookVocabulary', data.hookVocabulary, { multiline: true, hint: 'Opsional. Maksimal 300 kata atau frasa; satu per baris. Batas kolom 7.000 karakter; hanya panduan, bukan allowlist.' }),
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
    if (name === 'learning') loadLearning().catch((error) => show('#learning-error', errorText(error)));
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
      const feedback = document.createElement('td');
      if (post.status === 'published' && (post.id || post.slotId)) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button quiet'; button.textContent = 'Beri rating';
        button.setAttribute('aria-label', `Beri rating untuk posting ${post.id || post.slotId}`);
        button.addEventListener('click', () => {
          const slotInput = $('#learning-feedback-form').elements.slotId;
          slotInput.value = String(post.id || post.slotId);
          activateTab('learning');
          loadTabData('learning');
          requestAnimationFrame(() => { $('#learning-feedback-form').scrollIntoView({behavior:'smooth',block:'center'}); slotInput.focus({preventScroll:true}); });
        });
        feedback.append(button);
      } else feedback.textContent = '—';
      tr.append(time, pillar, statusCell, caption, feedback); return tr;
    });
    if (!rows.length) { const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5; cell.textContent = 'Belum ada riwayat posting.'; row.append(cell); rows.push(row); }
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
  function modelReasonText(reason) {
    return ({
      TEXT_MODALITY_UNSUPPORTED: 'Model tidak menerima dan menghasilkan teks.',
      COMPLETION_LIMIT_UNSUPPORTED: 'Model tidak mendukung batas token keluaran yang dipakai BotMerzz.',
      TEMPERATURE_UNSUPPORTED: 'Model tidak mendukung pengaturan temperature BotMerzz.',
      TOP_P_UNSUPPORTED: 'Model tidak mendukung pengaturan top-p BotMerzz.',
      METADATA_INCOMPLETE: 'Metadata OpenRouter belum cukup untuk memeriksa kompatibilitas.',
      MANUAL_ID: 'ID manual perlu diverifikasi langsung melalui OpenRouter.',
    })[reason] || '';
  }
  function modelStatusText(status) {
    return ({ AVAILABLE: 'Tersedia · kompatibel berdasarkan metadata', INCOMPATIBLE: 'Tidak kompatibel', NOT_FOUND: 'Tidak ditemukan', UNVERIFIED: 'Belum dapat diverifikasi' })[status] || 'Belum diverifikasi';
  }
  function closeModelOptions() {
    $('#integration-model-options').hidden = true;
    $('#integration-model-search').setAttribute('aria-expanded', 'false');
    $('#integration-model-search').removeAttribute('aria-activedescendant');
    state.modelActiveOption = -1;
  }
  function renderModelOptions(query) {
    const input = $('#integration-model-search');
    const list = $('#integration-model-options');
    const empty = $('#integration-model-empty');
    list.replaceChildren();
    const matches = searchOpenRouterModels(state.modelCatalog, query, 50);
    state.modelOptionMatches = matches;
    state.modelActiveOption = -1;
    if (!state.modelCatalog) {
      list.hidden = true; empty.hidden = true; input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant'); return;
    }
    if (!matches.length) {
      list.hidden = true; empty.hidden = false;
      empty.textContent = query ? 'Tidak ada model yang cocok. Coba nama, provider, atau Model ID lain.' : 'Katalog OpenRouter belum berisi model.';
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); return;
    }
    empty.hidden = true; list.hidden = false; input.setAttribute('aria-expanded', 'true');
    matches.forEach((model, index) => {
      const option = document.createElement('div');
      option.id = `integration-model-option-${index}`; option.className = 'model-option';
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(model.id === state.modelSelection?.id));
      option.dataset.modelIndex = String(index);
      const heading = document.createElement('span'); heading.className = 'model-option-heading';
      const name = document.createElement('strong'); name.textContent = model.name || model.id;
      const status = document.createElement('span'); status.className = `model-status model-status-${String(model.status || 'UNVERIFIED').toLowerCase()}`;
      status.textContent = modelStatusText(model.status);
      const id = document.createElement('span'); id.className = 'model-option-id'; id.textContent = model.id;
      const provider = document.createElement('span'); provider.className = 'model-option-provider'; provider.textContent = `Provider / namespace: ${model.provider || model.id.split('/')[0]}`;
      heading.append(name, status); option.append(heading, id, provider);
      const reason = modelReasonText(model.reason);
      if (reason) { const detail = document.createElement('span'); detail.className = 'model-option-reason'; detail.textContent = reason; option.append(detail); }
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => setModelSelection(model));
      list.append(option);
    });
  }
  function setActiveModelOption(index) {
    const matches = state.modelOptionMatches || [];
    if (!matches.length) return;
    state.modelActiveOption = Math.max(0, Math.min(index, matches.length - 1));
    const activeId = `integration-model-option-${state.modelActiveOption}`;
    $('#integration-model-search').setAttribute('aria-activedescendant', activeId);
    $$('.model-option', $('#integration-model-options')).forEach((option, optionIndex) => option.classList.toggle('is-active', optionIndex === state.modelActiveOption));
  }
  function renderModelValidation(status, message, kind = 'info') {
    const feedback = $('#integration-model-validation');
    feedback.className = `notice ${kind} full`;
    feedback.textContent = `${status ? `${status} · ` : ''}${message}`;
    feedback.dataset.validationStatus = status || 'UNVERIFIED';
  }
  function updateOpenRouterActions() {
    const form = $('#integration-model-form');
    if (!form) return;
    const model = form.elements.model.value;
    const pending = form.dataset.pending === 'true';
    const loaded = Boolean(state.integrations);
    $('#integration-model-verify').disabled = !loaded || !model || pending;
    const validation = state.modelValidation;
    const current = state.integrations?.configuration || {};
    $('#integration-model-form button[type="submit"]').disabled = !loaded || pending || !model
      || validation?.model !== model || validation?.version !== current.version || validation?.status !== 'AVAILABLE' || model === current.model;
  }
  function setModelSelection(model) {
    const selected = { id: model.id, name: model.name || model.id, provider: model.provider || model.id.split('/')[0], status: model.status || 'UNVERIFIED', reason: model.reason || null };
    state.modelSelection = selected; state.modelDraftDirty = true; state.modelValidation = null;
    $('#integration-model-id').value = selected.id;
    $('#integration-model-search').value = selected.name;
    $('#integration-model-manual').value = '';
    $('#integration-model-selection').textContent = `Dipilih: ${selected.name} · ${selected.id} · Provider / namespace ${selected.provider}.`;
    const reason = modelReasonText(selected.reason);
    renderModelValidation(selected.status, reason || 'Verifikasi ulang melalui backend sebelum model dapat diaktifkan.', selected.status === 'INCOMPATIBLE' ? 'warning' : 'info');
    closeModelOptions(); updateOpenRouterActions();
  }
  function clearModelSelection() {
    state.modelSelection = null; state.modelValidation = null; state.modelDraftDirty = true;
    $('#integration-model-id').value = '';
    $('#integration-model-selection').textContent = 'Belum ada model dipilih. Pilih hasil katalog atau gunakan opsi manual.';
    renderModelValidation('UNVERIFIED', 'Pilih model, lalu verifikasi sebelum menyimpan.');
    updateOpenRouterActions();
  }
  function updateModelVerificationFailure(error) {
    const status = modelValidationStatusFromError(error);
    state.modelValidation = null;
    const message = status === 'NOT_FOUND' ? 'Model tidak ditemukan di OpenRouter. Operasi verifikasi ini tidak mengubah konfigurasi aktif.'
      : status === 'INCOMPATIBLE' ? 'Model tersedia, tetapi tidak mendukung kebutuhan AI Content Generator dan Semantic Auditor.'
        : 'Status model belum dapat diverifikasi. Operasi verifikasi ini tidak mengubah konfigurasi aktif.';
    renderModelValidation(status, message, status === 'UNVERIFIED' ? 'warning' : 'error');
    updateOpenRouterActions();
  }
  async function handleModelSaveFailure(form, error) {
    state.modelValidation = null;
    if (error?.code === 'CONFIG_CONFLICT') {
      try { await loadIntegrations(); } catch { /* Keep the draft and report the version conflict. */ }
      renderModelValidation('UNVERIFIED', 'Konfigurasi berubah. Muat ulang dan verifikasi model kembali sebelum menyimpan.', 'warning');
      showFormError(form, error, '#integration-model-error');
      return;
    }
    const validationCodes = ['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE'];
    const providerValidationCodes = ['MODEL_METADATA_UNVERIFIED', 'OPENROUTER_NOT_CONFIGURED', 'OPENROUTER_RATE_LIMITED', 'OPENROUTER_UNAUTHORIZED', 'OPENROUTER_UNAVAILABLE'];
    if ((Number.isInteger(error?.status) && error.status < 500) || providerValidationCodes.includes(error?.code)) {
      updateModelVerificationFailure(error);
      if (validationCodes.includes(error?.code)) error.fields = { modelSearch: error.code };
      showFormError(form, error, '#integration-model-error');
      return;
    }
    let activeModel;
    try {
      const refreshed = await loadIntegrations();
      if (refreshed) activeModel = state.integrations?.configuration?.model || 'belum ada model aktif';
    } catch { /* A failed read leaves the mutation outcome unknown. */ }
    const message = activeModel
      ? `Respons penyimpanan tidak dapat dipastikan. Server saat ini menunjukkan model aktif ${activeModel}. Periksa riwayat konfigurasi sebelum mencoba lagi.`
      : 'Respons penyimpanan tidak dapat dipastikan dan status model aktif belum dapat dimuat. Muat ulang konfigurasi sebelum mencoba lagi.';
    renderModelValidation('UNVERIFIED', message, 'warning');
    const notice = $('#integration-model-error'); notice.textContent = message; notice.hidden = false;
    notify('warning', message);
    updateOpenRouterActions();
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
    const accountForm = $('#integration-account-form');
    $('button[type="submit"]', accountForm).disabled = !state.integrations || accountForm.dataset.pending === 'true';
    updateOpenRouterActions();
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
    if (state.modelValidation && state.modelValidation.version !== configuration.version) {
      state.modelValidation = null;
      renderModelValidation('UNVERIFIED', 'Konfigurasi berubah. Verifikasi model kembali sebelum menyimpan.');
    }
    syncIntegrationControls();
    state.integrationVerification = verification;
    $('#integration-active-profile').textContent = configuration.profileId || 'Belum dikonfigurasi';
    const verifiedAccount = verification?.profileId === configuration.profileId && verification?.accountId === configuration.accountId ? verification.account : null;
    $('#integration-active-account').textContent = `${configuration.accountId || 'Belum dikonfigurasi'}${verifiedAccount?.username ? ` · @${verifiedAccount.username}` : ''}`;
    $('#integration-provider-status').textContent = verifiedAccount ? `Terverifikasi · ${verifiedAccount.platform || 'Threads'} · ${verifiedAccount.status || 'status tidak diketahui'}` : 'Belum diverifikasi pada halaman ini';
    $('#integration-check-active').disabled = !configuration.profileId || !configuration.accountId;
    $('#ai-active-model').textContent = configuration.model || 'Belum dikonfigurasi';
    $('#ai-notice').textContent = configuration.model ? 'Model aktif dibaca dari konfigurasi server.' : 'Belum ada model yang dikonfigurasi.';
    $('#ai-active-model-status').textContent = configuration.model
      ? 'Tersimpan aktif di MySQL. Ketersediaan provider tidak diuji saat halaman dimuat.'
      : 'Belum ada model aktif.';
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
    const activeModel = configuration.model || '';
    if (!state.modelDraftDirty) {
      state.modelValidation = null;
      state.modelSelection = activeModel ? { id: activeModel, name: activeModel, provider: activeModel.split('/')[0], status: 'UNVERIFIED', reason: null } : null;
      modelForm.elements.model.value = activeModel;
      $('#integration-model-search').value = activeModel;
      $('#integration-model-selection').textContent = activeModel
        ? `Model aktif ${activeModel} dipilih sebagai draft. Verifikasi kembali sebelum mengaktifkannya.`
        : 'Pilih model dari katalog, lalu verifikasi sebelum menyimpan.';
      renderModelValidation('UNVERIFIED', activeModel ? 'Verifikasi ulang model aktif jika ingin menyimpannya sebagai perubahan.' : 'Pilih model, lalu verifikasi sebelum menyimpan.');
    }
    modelForm.dataset.baseline = activeModel;
    updateOpenRouterActions();
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
    const model = form.elements.model.value.trim();
    const currentVersion = state.integrations?.configuration?.version;
    if (!model || state.modelValidation?.model !== model || state.modelValidation?.version !== currentVersion) {
      renderModelValidation('UNVERIFIED', 'Verifikasi model kembali sebelum menyimpan perubahan.', 'warning');
      updateOpenRouterActions(); return;
    }
    let activationAttempted = false;
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        const expectedVersion = integrationVersion();
        const checked = await api('/api/integrations/validate-model', { method: 'POST', body: JSON.stringify({ model }) });
        const identity = checked.model?.name || checked.model?.id || model;
        state.modelValidation = { model, version: expectedVersion, status: 'AVAILABLE' };
        renderModelValidation('AVAILABLE', 'Model kembali ditemukan dan kompatibel berdasarkan metadata. Keberhasilan generasi berikutnya tetap bergantung pada provider.', 'success');
        if (!confirmAction(`Gunakan model ${identity} (${model}) untuk generasi berikutnya?`)) return;
        activationAttempted = true;
        const result = await api('/api/integrations/model', { method: 'PUT', body: JSON.stringify({ model, expectedVersion }) });
        form.dataset.baseline = model; state.modelDraftDirty = false; state.modelValidation = null;
        await finishIntegrationMutation(result.configuration, 'Model AI berhasil diperbarui untuk generasi berikutnya.', true);
      }, 'Memeriksa…', form);
    } catch (error) {
      if (activationAttempted) { await handleModelSaveFailure(form, error); return; }
      updateModelVerificationFailure(error);
      if (['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE'].includes(error.code)) error.fields = { modelSearch: error.code };
      showFormError(form, error, '#integration-model-error');
    }
  });
  $('#integration-model-verify').addEventListener('click', async (event) => {
    const form = $('#integration-model-form'); const model = form.elements.model.value.trim();
    if (!model) { renderModelValidation('UNVERIFIED', 'Pilih model dari katalog atau masukkan ID manual terlebih dahulu.', 'warning'); return; }
    hide('#integration-model-error');
    try {
      await withPending(event.currentTarget, async () => {
        const version = integrationVersion();
        renderModelValidation('UNVERIFIED', 'Memeriksa metadata model melalui backend…');
        const result = await api('/api/integrations/validate-model', { method: 'POST', body: JSON.stringify({ model }) });
        state.modelSelection = { id: result.model?.id || model, name: result.model?.name || model, provider: result.model?.provider || model.split('/')[0], status: 'AVAILABLE', reason: null };
        state.modelValidation = { model, version, status: 'AVAILABLE' };
        renderModelValidation('AVAILABLE', 'Model tersedia dan kompatibel berdasarkan metadata OpenRouter. Ini bukan jaminan setiap request generasi akan berhasil.', 'success');
        notify('success', 'Metadata model tersedia dan kompatibel. Ketersediaan request generasi berikutnya tetap bergantung pada provider.');
      }, 'Memverifikasi…', form);
    } catch (error) {
      updateModelVerificationFailure(error);
      if (['INVALID_MODEL', 'MODEL_NOT_FOUND', 'MODEL_INCOMPATIBLE'].includes(error.code)) error.fields = { modelSearch: error.code };
      showFormError(form, error, '#integration-model-error');
    }
  });
  $('#integration-model-catalog').addEventListener('click', async (event) => {
    try {
      await withPending(event.currentTarget, async () => {
        const request = state.modelCatalogRequest = (state.modelCatalogRequest || 0) + 1;
        state.modelCatalog = null;
        $('#integration-model-catalog-status').textContent = 'Memuat katalog model dari OpenRouter…';
        $('#integration-model-empty').hidden = true;
        const result = await api('/api/integrations/models');
        if (request !== state.modelCatalogRequest) return;
        state.modelCatalog = Array.isArray(result.models) ? result.models.filter((model) => typeof model?.id === 'string') : [];
        const available = state.modelCatalog.filter((model) => model.status === 'AVAILABLE').length;
        $('#integration-model-catalog-status').textContent = state.modelCatalog.length
          ? `Katalog dimuat: ${state.modelCatalog.length} model. ${available} kompatibel berdasarkan metadata; status bukan jaminan request generasi.`
          : 'Katalog OpenRouter tidak berisi model. Coba muat ulang nanti.';
        renderModelOptions($('#integration-model-search').value);
      }, 'Memuat…', null);
    } catch (error) {
      state.modelCatalog = null; closeModelOptions();
      $('#integration-model-catalog-status').textContent = 'UNVERIFIED · katalog tidak dapat dimuat. Coba muat ulang; model manual tetap harus diverifikasi.';
      show('#integration-model-error', integrationError(error));
    }
  });
  $('#integration-model-search').addEventListener('focus', (event) => {
    if (!state.modelCatalog) return;
    const selected = state.modelSelection?.name === event.currentTarget.value;
    renderModelOptions(selected ? '' : event.currentTarget.value);
  });
  $('#integration-model-search').addEventListener('input', (event) => {
    clearModelSelection(); renderModelOptions(event.currentTarget.value);
  });
  $('#integration-model-search').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const wasHidden = $('#integration-model-options').hidden;
      if (wasHidden) renderModelOptions(event.currentTarget.value);
      if (state.modelOptionMatches.length) setActiveModelOption(state.modelActiveOption < 0 ? 0 : state.modelActiveOption + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const wasHidden = $('#integration-model-options').hidden;
      if (wasHidden) renderModelOptions(event.currentTarget.value);
      if (state.modelOptionMatches.length) setActiveModelOption(state.modelActiveOption < 0 ? state.modelOptionMatches.length - 1 : state.modelActiveOption - 1);
    } else if (event.key === 'Enter' && !$('#integration-model-options').hidden && state.modelActiveOption >= 0) {
      event.preventDefault(); setModelSelection(state.modelOptionMatches[state.modelActiveOption]);
    } else if (event.key === 'Escape') closeModelOptions();
    else if (event.key === 'Tab') closeModelOptions();
  });
  $('#integration-model-use-manual').addEventListener('click', () => {
    const model = $('#integration-model-manual').value.trim();
    hide('#integration-model-error');
    if (!model) { renderModelValidation('UNVERIFIED', 'Masukkan Model ID tanpa perubahan otomatis, lalu pilih Gunakan ID.', 'warning'); $('#integration-model-manual').focus(); return; }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,98}$/.test(model)) {
      const error = Object.assign(new Error('INVALID_MODEL'), { code: 'INVALID_MODEL' });
      renderModelValidation('INCOMPATIBLE', 'Format Model ID tidak valid. Gunakan namespace/model-id yang persis dari OpenRouter.', 'error');
      error.fields = { modelSearch: 'INVALID_MODEL' };
      showFormError($('#integration-model-form'), error, '#integration-model-error'); return;
    }
    setModelSelection({ id: model, name: model, provider: model.split('/')[0], status: 'UNVERIFIED', reason: 'MANUAL_ID' });
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
    const rawHours = value(form, 'hours').trim(); const rawMinutes = value(form, 'minutes').trim();
    const currentSchedule = { ...(settings.schedule || {}) };
    delete currentSchedule.intervalMinutes; delete currentSchedule.intervalHours; delete currentSchedule.hours; delete currentSchedule.minutes;
    settings.schedule = { ...currentSchedule, hours: rawHours === '' ? null : Number(rawHours), minutes: rawMinutes === '' ? null : Number(rawMinutes) };
    settings.priceMode = value(form, 'priceMode');
    try {
      await withPending(event.submitter || $('button[type="submit"]', form), async () => {
        state.data.settings = await api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) });
        show('#global-success', 'Jadwal berhasil disimpan.'); await refreshAfterMutation(refresh);
      }, 'Menyimpan…', form);
    } catch (error) { showFormError(form, error); }
  });
  ['hours', 'minutes'].forEach((name) => $('#schedule-form').elements.namedItem(name).addEventListener('input', updateScheduleIntervalSummary));

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

  function learningNode(tag, text, className) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text == null || text === '' ? '—' : String(text);
    return element;
  }
  function learningDate(value) {
    const date = new Date(value);
    return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('id-ID') : '—';
  }
  function learningEmpty(target, message) {
    target.replaceChildren(learningNode('p', message, 'muted'));
  }
  function showLearningCandidateDetails(candidate) {
    const target = $('#learning-candidate-dialog-content');
    const fields = [
      ['Status', candidate.status], ['Sumber dan kategori', `${candidate.source || '—'} · ${candidate.category || '—'}`],
      ['Slot', candidate.slotId], ['Attempt', candidate.attemptId || 'Tidak diketahui'],
      ['Evidence', candidate.evidenceStatus === 'available' ? 'Tersedia dan disaring' : `Tidak tersedia (${candidate.evidenceReason || 'alasan tidak diketahui'})`],
      ['Konten asal', candidate.caption || 'Bukti caption asal tidak tersedia. Caption lain tidak digunakan sebagai pengganti.'],
      ['Penjelasan', candidate.feedbackExplanation || candidate.explanation || 'Tidak tersedia'],
      ['Rating manusia', Object.entries(candidate.ratings || {}).map(([key, value]) => `${key}: ${value}/5`).join(' · ') || 'Tidak ada dimensi yang dinilai'],
      ['Usulan instruksi', candidate.instructionStatus === 'withheld'
        ? 'Arahan kandidat disembunyikan untuk melindungi maklumat sensitif.'
        : (candidate.instruction || 'Belum ada usulan instruksi')],
    ];
    target.replaceChildren(...fields.map(([label, value]) => {
      const item = document.createElement('section'); item.className = 'learning-detail-field';
      item.append(learningNode('strong', label), learningNode('p', value)); return item;
    }));
    const dialog = $('#learning-candidate-dialog');
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    $('#learning-candidate-dialog-close').focus();
  }
  function renderLearningCandidates(candidates, { append = false } = {}) {
    const target = $('#learning-candidates');
    if (!candidates.length) { if (!append) learningEmpty(target, 'Tidak ada kandidat untuk penapis ini.'); return; }
    const existing = append ? [...target.children] : [];
    const items = candidates.map((candidate) => {
      const form = document.createElement('form'); form.className = 'learning-item stack';
      form.append(learningNode('strong', `${candidate.category || 'Umpan balik'} · ${candidate.source || 'Sumber tidak diketahui'}`));
      form.append(learningNode('p', `Slot: ${candidate.slotId || '—'} · ${learningDate(candidate.createdAt)} · ${candidate.status || 'pending'}`, 'muted'));
      if (candidate.source === 'validation') form.append(learningNode('p', `Percobaan: ${candidate.attemptId || 'tidak diketahui'} · Bukti: ${candidate.evidenceStatus === 'available' ? 'tersedia (telah disaring)' : 'tidak tersedia'}${candidate.evidenceReason ? ` · ${candidate.evidenceReason}` : ''}`, 'muted'));
      form.append(learningNode('p', `Konten: ${candidate.caption || 'Tidak tersedia'}`, 'learning-evidence'));
      form.append(learningNode('p', `Penjelasan: ${candidate.explanation || 'Tidak tersedia'}`));
      if (candidate.source === 'feedback') {
        form.append(learningNode('p', `Rating ${candidate.feedbackType || candidate.category || 'feedback'}: ${Object.entries(candidate.ratings || {}).map(([key,value]) => `${key} ${value}/5`).join(' · ') || 'tiada rating dimensi'}`, 'muted'));
      }
      const detailsButton = learningButton('Lihat butiran', 'quiet', () => showLearningCandidateDetails(candidate));
      detailsButton.setAttribute('aria-haspopup', 'dialog');
      form.append(detailsButton);
      if (candidate.status !== 'pending') return form;
      const instructionLabel = learningNode('label', 'Usulan instruksi');
      const instruction = document.createElement('textarea'); instruction.name = 'instruction'; instruction.rows = 3; instruction.maxLength = 500; instruction.value = candidate.instruction || ''; instruction.setAttribute('aria-describedby','learning-text-data-guidance'); instructionLabel.append(instruction);
      if (candidate.instructionStatus === 'withheld') form.append(learningNode('p','Arahan lama disembunyikan. Sahkan kandungan baharu sebelum meluluskan.','field-hint'));
      const scopeLabel = learningNode('label', 'Lingkup'); const scope = document.createElement('select'); scope.name = 'scope';
      for (const [value, label] of [['', 'Pilih lingkup'], ['global', 'Global'], ['account', 'Akun ML'], ['topup', 'Top-up']]) { const option = learningNode('option', label); option.value = value; scope.append(option); }
      scope.value = ''; scopeLabel.append(scope);
      scopeLabel.append(learningNode('span', `Lingkup sumber: ${candidate.scope || 'tidak tersedia'}`, 'field-hint'));
      const topicLabel = learningNode('label', 'Topik konten'); const topic = document.createElement('select'); topic.name = 'contentTopic';
      for (const [value, label] of [['all','Semua topik'],['education','Edukasi'],['community','Komuniti'],['gamer_observation','Pemerhatian gamer'],['relatable_situation','Situasi relatable'],['brand_awareness','Kesedaran jenama'],['trust','Kepercayaan']]) { const option = learningNode('option',label); option.value = value; topic.append(option); }
      topicLabel.append(topic);
      const reasonLabel = learningNode('label', 'Alasan keputusan'); const reason = document.createElement('input'); reason.name = 'reason'; reason.maxLength = 300; reason.setAttribute('aria-describedby','learning-text-data-guidance'); reasonLabel.append(reason);
      const actions = document.createElement('div'); actions.className = 'form-actions';
      for (const [decision, label] of [['approved', 'Setujui'], ['rejected', 'Tolak'], ['false_positive', 'Tandai false positive']]) {
        const button = learningNode('button', label, decision === 'approved' ? 'button primary' : 'button quiet'); button.type = 'button';
        button.addEventListener('click', () => withPending(button, async () => {
          if (decision === 'approved' && (!instruction.value.trim() || !scope.value)) { show('#learning-error', 'Isi instruksi dan pilih lingkup sebelum menyetujui.'); (!instruction.value.trim() ? instruction : scope).focus(); return; }
          const actionLabel = decision === 'approved' ? 'Setujui kandidat ini' : decision === 'rejected' ? 'Tolak kandidat ini' : 'Tandai kandidat ini sebagai false positive';
          if (!confirmAction(`${actionLabel}? Keputusan akan disimpan dalam riwayat review.`)) return;
          try {
            await api(`/api/learning/candidates/${encodeURIComponent(candidate.id)}/decision`, { method: 'POST', body: JSON.stringify({ version: candidate.version, decision, instruction: instruction.value.trim(), scope: scope.value, productCategory: scope.value === 'global' ? 'all' : scope.value, contentTopic: topic.value, reason: reason.value.trim() }) });
            hide('#learning-error'); show('#global-success', 'Keputusan review tersimpan.'); await loadLearning();
          } catch (error) { show('#learning-error', errorText(error)); }
        }, 'Menyimpan…'));
        actions.append(button);
      }
      form.append(instructionLabel, scopeLabel, topicLabel, reasonLabel, actions); return form;
    });
    target.replaceChildren(...existing, ...items);
  }
  function learningButton(label, className, handler, disabled = false) {
    const button = learningNode('button', label, `button ${className}`); button.type = 'button'; button.disabled = disabled;
    button.addEventListener('click', (event) => handler(event.currentTarget)); return button;
  }
  function learningSelect(labelText, name, options, selected) {
    const label = learningNode('label', labelText); const select = document.createElement('select'); select.name = name;
    for (const [value, labelValue] of options) { const option = learningNode('option', labelValue); option.value = value; select.append(option); }
    select.value = selected; label.append(select); return {label,select};
  }
  function learningAction(button, action, progress = 'Memproses…') {
    return withPending(button, async () => {
      try { await action(); }
      catch (error) { show('#learning-error', errorText(error)); }
    }, progress);
  }
  function lifecycleReason() { return ''; }
  const learningTopics = [['all','Semua topik'],['education','Edukasi'],['community','Komuniti'],['gamer_observation','Pemerhatian gamer'],['relatable_situation','Situasi relatable'],['brand_awareness','Kesedaran jenama'],['trust','Kepercayaan']];
  function activationConflictLabel(code) {
    if (code === 'active_rule_limit_reached') return 'batas maksimum 500 aturan aktif telah tercapai';
    if (code === 'active_rule_population_exceeds_limit') return 'jumlah aturan aktif melebihi batas 500; pengambilan aturan dinonaktifkan';
    return code;
  }
  function showActivationResult(target, preview) {
    const details = preview.conflicts?.length
      ? `Aktivasi disekat: ${preview.conflicts.map((item) => `${activationConflictLabel(item.code)}${item.ruleId ? ` (aturan ${item.ruleId})` : ''}`).join(', ')}.`
      : `Tiada konflik deterministik ditemukan. Anggaran prompt: ${preview.estimatedPromptTokens || 0} token.`;
    target.replaceChildren(learningNode('p', details, preview.conflicts?.length ? 'notice error' : 'notice info'));
  }
  async function renderRuleVersions(rule, panel) {
    panel.replaceChildren(learningNode('p', 'Memuat versi dan audit…', 'muted'));
    try {
      const [{versions = []}, {actions = []}] = await Promise.all([
        api(`/api/learning/rules/${encodeURIComponent(rule.id)}/versions`),
        api(`/api/learning/rules/${encodeURIComponent(rule.id)}/history`),
      ]);
      const content = [];
      for (const version of versions) {
        const row = document.createElement('article'); row.className = 'learning-item stack';
        row.append(learningNode('strong', `Versi ${version.version} · ${version.decision || 'pending'}${Number(rule.activeVersion) === Number(version.version) ? ' · digunakan' : ''}`));
        row.append(learningNode('p', `Skop ${version.scope} · kategori ${version.productCategory} · topik ${version.contentTopic} · sumber kandidat ${version.source?.candidateId || 'legacy'}`, 'muted'));
        const instructionText = version.instructionStatus === 'withheld'
          ? 'Arahan versi disembunyikan untuk melindungi maklumat sensitif.'
          : (version.instruction || 'Arahan versi tidak tersedia.');
        row.append(learningNode('p', instructionText, 'learning-evidence'));
        const controls = document.createElement('div'); controls.className = 'form-actions';
        if (version.decision === 'pending') {
          for (const decision of ['approved','rejected']) controls.append(learningButton(decision === 'approved' ? 'Luluskan versi' : 'Tolak versi', decision === 'approved' ? 'primary' : 'quiet', (button) => learningAction(button, async () => {
            if (!confirmAction(`${decision === 'approved' ? 'Luluskan' : 'Tolak'} versi ${version.version} aturan ${rule.id}? Keputusan akan disimpan dalam riwayat.`)) return;
            await api(`/api/learning/rules/${encodeURIComponent(rule.id)}/versions/${encodeURIComponent(version.version)}/decision`, {method:'POST',body:JSON.stringify({decision,reason:lifecycleReason()})});
            await loadLearning();
          })));
        } else if (version.decision === 'approved' && state.learningCapabilities?.activationEnabled === true && Number(rule.activeVersion) !== Number(version.version) && !rule.superseded) {
          const rollback = Number(rule.activeVersion) > Number(version.version);
          controls.append(learningButton(rollback ? 'Pulihkan versi ini' : 'Aktifkan versi ini', 'quiet', (button) => learningAction(button, async () => {
            const preview = await api(`/api/learning/rules/${encodeURIComponent(rule.id)}/activation-preview`, {method:'POST',body:JSON.stringify({version:version.version})});
            if (!preview.preview?.canActivate) { showActivationResult(panel, preview.preview || {}); return; }
            if (!confirmAction(`${rollback ? 'Pulihkan' : 'Aktifkan'} versi ${version.version}? Penggunaan prompt masih memerlukan flag server yang berasingan.`)) return;
            const actionPath = rollback
              ? `/api/learning/rules/${encodeURIComponent(rule.id)}/rollback`
              : `/api/learning/rules/${encodeURIComponent(rule.id)}/activation`;
            await api(actionPath,{method:'POST',body:JSON.stringify({version:version.version,reason:lifecycleReason()})});
            await loadLearning();
          })));
        }
        row.append(controls); content.push(row);
      }
      const audit = document.createElement('details'); const summary = learningNode('summary', `Audit tindakan (${actions.length})`); audit.append(summary);
      if (actions.length) for (const action of actions) audit.append(learningNode('p', `${action.action} · versi ${action.version ?? '—'} · admin ${action.actorId} · ${learningDate(action.createdAt)} · ${action.reason || 'tanpa alasan'}`, 'muted'));
      else audit.append(learningNode('p', 'Belum ada tindakan.', 'muted'));
      content.push(audit);
      panel.replaceChildren(...(content.length ? content : [learningNode('p','Riwayat versi belum tersedia.','muted')]));
    } catch (error) { panel.replaceChildren(learningNode('p', `Riwayat tidak dapat dimuat: ${errorText(error)}`, 'notice error')); }
  }
  function renderLearningRules(rules) {
    const target = $('#learning-rules');
    if (!rules.length) { learningEmpty(target, 'Belum ada pembelajaran yang disetujui.'); renderShadowRuleOptions([]); return; }
    const activationEnabled = state.learningCapabilities?.activationEnabled === true;
    target.replaceChildren(...rules.map((rule) => {
      const item = document.createElement('article'); item.className = 'learning-item stack';
      const header = document.createElement('div'); header.className = 'learning-rule-header';
      header.append(learningNode('strong', `Aturan ${rule.id} · ${rule.approvalStatus || 'status tidak diketahui'}${rule.superseded ? ' · diganti' : ''}`));
      const instructionText = rule.instructionStatus === 'withheld'
        ? 'Arahan aturan disembunyikan untuk melindungi maklumat sensitif.'
        : (rule.instruction || 'Arahan aturan tidak tersedia.');
      item.append(header, learningNode('p', instructionText, 'learning-evidence'));
      item.append(learningNode('p', `Skop: ${rule.scope} · kategori: ${rule.productCategory} · topik: ${rule.contentTopic} · versi terkini: ${rule.version} · versi aktif: ${rule.activeVersion ?? 'tiada'} · ${rule.active ? 'Aktif' : 'Tidak aktif'}`, 'muted'));
      const lifecycleStatus=document.createElement('div'); lifecycleStatus.setAttribute('role','status');
      const actions = document.createElement('div'); actions.className = 'form-actions';
      if (!rule.superseded && rule.active) actions.append(learningButton('Nyahaktifkan', 'quiet', (button) => learningAction(button, async () => {
          if (!confirmAction(`Nyahaktifkan aturan ${rule.id} versi ${rule.activeVersion}?`)) return;
          await api(`/api/learning/rules/${encodeURIComponent(rule.id)}/deactivation`, {method:'POST',body:JSON.stringify({version:rule.activeVersion,reason:lifecycleReason()})}); await loadLearning();
        }), !activationEnabled));
      else if (rule.approvalStatus === 'approved' && !rule.superseded) actions.append(learningButton('Semak konflik & aktifkan', 'primary', (button) => learningAction(button, async () => {
          const version = rule.approvalStatus === 'approved' ? rule.version : rule.activeVersion;
          const {preview} = await api(`/api/learning/rules/${encodeURIComponent(rule.id)}/activation-preview`, {method:'POST',body:JSON.stringify({version})});
          showActivationResult(lifecycleStatus, preview);
          if (!preview.canActivate) return;
          if (!confirmAction(`Aktifkan aturan ${rule.id} versi ${version}? Prompt integration kekal mengikut flag server.`)) return;
          await api(`/api/learning/rules/${encodeURIComponent(rule.id)}/activation`, {method:'POST',body:JSON.stringify({version,reason:lifecycleReason()})}); await loadLearning();
        }), !activationEnabled));
      const historyPanel = document.createElement('div'); historyPanel.hidden = true;
      actions.append(learningButton('Versi & audit', 'quiet', async (button) => {
        historyPanel.hidden = !historyPanel.hidden;
        button.setAttribute('aria-expanded', String(!historyPanel.hidden));
        if (!historyPanel.hidden) await renderRuleVersions(rule,historyPanel);
      }));
      const revision = learningButton('Buat revisi', 'quiet', (button) => {
        const form = document.createElement('form'); form.className = 'stack learning-revision-form';
        const instructionLabel = learningNode('label','Instruksi revisi'); const instruction = document.createElement('textarea'); instruction.name='instruction'; instruction.maxLength=500; instruction.rows=3; instruction.value=rule.instruction || ''; instruction.setAttribute('aria-describedby','learning-text-data-guidance'); instructionLabel.append(instruction);
        const scopeField = learningSelect('Skop','scope',[['global','Global'],['account','Akun ML'],['topup','Top-up']],rule.scope);
        const topicField = learningSelect('Topik','contentTopic',learningTopics,rule.contentTopic || 'all');
        const reasonLabel = learningNode('label','Sebab perubahan (pilihan)'); const reason = document.createElement('input'); reason.name='reason'; reason.maxLength=300; reason.setAttribute('aria-describedby','learning-text-data-guidance'); reasonLabel.append(reason);
        const submit = learningNode('button','Simpan sebagai versi menunggu kelulusan','button primary'); submit.type='submit';
        form.append(instructionLabel,scopeField.label,topicField.label,reasonLabel,submit);
        form.addEventListener('submit',(event)=>{event.preventDefault(); learningAction(submit,async()=>{
          await api(`/api/learning/rules/${encodeURIComponent(rule.id)}/revisions`,{method:'POST',body:JSON.stringify({expectedVersion:rule.version,instruction:instruction.value.trim(),scope:scopeField.select.value,productCategory:scopeField.select.value==='global'?'all':scopeField.select.value,contentTopic:topicField.select.value,reason:reason.value.trim()})});
          await loadLearning();
        },'Menyimpan…',form);});
        item.insertBefore(form,historyPanel); form.scrollIntoView({behavior:'smooth',block:'nearest'}); button.disabled=true;
      }, rule.superseded);
      actions.append(revision);
      if (rule.active) {
        const supersedeForm = document.createElement('form'); supersedeForm.className='form-actions learning-supersede-form';
        const replacementId = document.createElement('input'); replacementId.inputMode='numeric'; replacementId.maxLength=20; replacementId.placeholder='ID aturan pengganti'; replacementId.setAttribute('aria-label','ID aturan pengganti');
        const replacementVersion = document.createElement('input'); replacementVersion.inputMode='numeric'; replacementVersion.maxLength=10; replacementVersion.placeholder='Versi'; replacementVersion.setAttribute('aria-label','Versi aturan pengganti');
        const supersede = learningNode('button','Ganti aturan aktif','button quiet'); supersede.type='submit'; supersede.disabled=!activationEnabled;
        supersedeForm.append(replacementId,replacementVersion,supersede);
        supersedeForm.addEventListener('submit',(event)=>{event.preventDefault(); learningAction(supersede,async()=>{
          if (!/^\d+$/.test(replacementId.value) || !/^\d+$/.test(replacementVersion.value)) throw Object.assign(new Error('Masukkan ID dan versi aturan pengganti.'),{code:'INVALID_SUPERSESSION'});
          if (!confirmAction(`Ganti aturan ${rule.id} versi ${rule.activeVersion} dengan aturan ${replacementId.value}?`)) return;
          await api(`/api/learning/rules/${encodeURIComponent(rule.id)}/supersession`,{method:'POST',body:JSON.stringify({version:rule.activeVersion,replacementRuleId:replacementId.value,replacementVersion:Number(replacementVersion.value),reason:lifecycleReason()})}); await loadLearning();
        },'Memproses…',supersedeForm);});
        item.append(supersedeForm);
      }
      item.append(lifecycleStatus,actions,historyPanel);
      return item;
    }));
    renderShadowRuleOptions(rules);
  }
  function renderLearningReviews(reviews) {
    const target = $('#learning-reviews');
    if (!reviews.length) { learningEmpty(target, 'Belum ada riwayat review.'); return; }
    target.replaceChildren(...reviews.map((review) => {
      const item = document.createElement('div'); item.className = 'learning-item';
      item.append(learningNode('strong', review.action), learningNode('p', `Kandidat: ${review.candidateId || '—'} · Admin: ${review.actorId || '—'} · ${learningDate(review.createdAt)}`, 'muted'), learningNode('p', review.reason || 'Tidak ada alasan tertulis.'));
      return item;
    }));
  }
  function percent(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'Belum cukup data'; }
  function metricCard(name, summary, details) {
    const card = document.createElement('article'); card.className='metric'; card.append(learningNode('span',name),learningNode('strong',summary),learningNode('small',details)); return card;
  }
  function complianceSummary(compliance) {
    const rate=percent(compliance.firstPassApprovalRate);
    if(compliance.status==='complete'&&Number.isFinite(compliance.firstPassApprovalRate))return rate;
    if(compliance.status==='incomplete')return Number.isFinite(compliance.firstPassApprovalRate)?`Sementara · ${rate}`:'Data belum lengkap';
    return 'Belum cukup data';
  }
  function metricDetails(label, lines) {
    const details = document.createElement('details'); details.className = 'metric-details';
    details.append(learningNode('summary', label));
    const body = document.createElement('div'); body.className = 'metric-detail-lines';
    for (const line of lines.filter(Boolean)) body.append(learningNode('small', line));
    details.append(body); return details;
  }
  function renderLearningMetrics(result) {
    const target=$('#learning-metrics');
    if (!result) { learningEmpty(target,'Metrik tidak dapat dimuat. Cuba muat ulang.'); return; }
    const compliance=result.compliance||{}; const quality=result.quality||{}; const effectiveness=result.effectiveness||{};
    const firstPassDenominator=Number.isInteger(compliance.firstPassDenominator)?compliance.firstPassDenominator:'belum tersedia';
    const complianceDetails=`Lulus ${compliance.firstPassSuccesses||0} / ${firstPassDenominator} percubaan pertama · populasi eligible ${compliance.eligibleFirstAttempts||0} · pengecualian teknikal ${compliance.technicalExclusions||0} · kontekstual ${compliance.contextualFailures||0} · tidak diketahui ${compliance.unknownOutcomes||0} · belum selesai ${compliance.incompleteOutcomes||0} · percubaan hilang ${compliance.missingAttempts||0} · liputan rekod ${percent(compliance.attemptRecordCoverage)} · liputan outcome terminal ${percent(compliance.terminalOutcomeCoverage)} · deterministik ${percent(compliance.deterministicStage?.passRate)} · Semantic Auditor ${percent(compliance.semanticStage?.passRate)} · ${compliance.statusText||'Belum cukup data'}`;
    const qualityDetails=`Maklum balas ${quality.reviewedCaptions||0} / ${quality.eligibleCaptions||0} kandungan (${percent(quality.feedbackCoverage)}) · positif ${quality.positiveFeedbackSubmissions||0} · negatif ${quality.negativeFeedbackSubmissions||0} · ${quality.statusText||'Belum cukup data'}`;
    const effectivenessDetails=`Perbandingan aturan ${effectiveness.comparisonCount||0} · ${effectiveness.statusText||'Belum cukup data'} · pemerhatian sahaja, tiada dakwaan sebab-akibat`;
    const cards=[metricCard('Content Compliance',complianceSummary(compliance),complianceDetails),metricCard('Content Quality',percent(quality.feedbackCoverage),qualityDetails),metricCard('Learning Effectiveness',effectiveness.statusText||'Belum cukup data',effectivenessDetails)];
    const failureLines=Object.entries(compliance.failureCategories||{}).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([code,count])=>`Kategori ${code}: ${count}`);
    cards[0].append(metricDetails('Perincian outcome dan tahap validasi',[
      `Lulus pertama ${compliance.firstPassSuccesses||0} / ${firstPassDenominator}; populasi eligible ${compliance.eligibleFirstAttempts||0}; pengecualian teknikal ${compliance.technicalExclusions||0}; outcome lulus atau gagal kontekstual yang dinilai ${compliance.evaluatedFirstAttempts||0}.`,
      `Liputan rekod ${percent(compliance.attemptRecordCoverage)}; liputan terminal ${percent(compliance.terminalOutcomeCoverage)}; status ${compliance.statusText||'Belum cukup data'}.`,
      `Validasi deterministik: ${compliance.deterministicStage?.passed||0} lulus, ${compliance.deterministicStage?.failed||0} gagal, ${percent(compliance.deterministicStage?.passRate)}.`,
      `Semantic Auditor: ${compliance.semanticStage?.passed||0} lulus, ${compliance.semanticStage?.failed||0} gagal, ${percent(compliance.semanticStage?.passRate)}.`,
      ...failureLines,
    ]));
    for (const dimension of Object.keys(quality.dimensions||{})) {
      const data=quality.dimensions[dimension]; cards[1].append(learningNode('small',`${dimension}: ${data.average==null?'tiada rating':data.average.toFixed(2)} / 5 · ${data.captionSampleSize||0} kandungan dinilai · n=${data.count}${data.smallSample?' · sampel kecil':''}`));
    }
    cards[1].append(metricDetails('Perincian maklum balas manusia',[
      `Kandungan layak ${quality.eligibleCaptions||0}; kandungan disemak ${quality.reviewedCaptions||0}; belum disemak ${quality.unreviewedCaptions||0}.`,
      `Jumlah hantaran feedback ${quality.feedbackSubmissions||0}; feedback tanpa rating dimensi ${quality.unratedFeedback||0}; status ${quality.statusText||'Belum cukup data'}.`,
      `Rubrik ${quality.rubricVersion||'—'}; sampel minimum ${quality.minimumCaptions||0}; tiada engagement atau conversion pihak luar disimpulkan.`,
      ...(quality.trends||[]).slice(-6).map((trend)=>`${trend.month}: ${trend.reviewedCaptions}/${trend.eligibleCaptions} disemak · liputan ${percent(trend.feedbackCoverage)} · positif ${trend.positiveFeedbackSubmissions} · negatif ${trend.negativeFeedbackSubmissions}`),
    ]));
    for (const comparison of effectiveness.comparisons||[]) {
      cards[2].append(learningNode('small',`Aturan ${comparison.ruleId} v${comparison.version}: percubaan beratribusi baseline=${comparison.baseline?.attributedAttempts||0}, selepas=${comparison.observed?.attributedAttempts||0}; sampel outcome percubaan pertama n=${comparison.baseline?.firstAttemptOutcomeSampleSize||0}/${comparison.observed?.firstAttemptOutcomeSampleSize||0}; kegagalan kontekstual ${comparison.failureRateDifference==null?'—':percent(comparison.failureRateDifference)} · kategori sumber ${comparison.relevantFailureCategory||'tiada'} (${comparison.relevantFailureRateDifference==null?'—':percent(comparison.relevantFailureRateDifference)}) · fakta berubah ${comparison.confounders?.factsChanged?'ya':'tidak diketahui'} · panduan berubah ${comparison.confounders?.guidelinesChanged?'ya':'tidak diketahui'} · validator berubah ${comparison.confounders?.validatorChanged?'ya':'tidak diketahui'} · model/konfigurasi berubah ${comparison.confounders?.modelOrConfigChanged?'ya':'tidak diketahui'} · ${comparison.statusText||'Belum cukup data'}`));
      const armLines=(label,arm)=>[
        `${label}: ${arm?.windowFrom||'—'} hingga ${arm?.windowTo||'—'}.`,
        `Percubaan beratribusi ${arm?.attributedAttempts||0}; sampel outcome percubaan pertama ${arm?.firstAttemptOutcomeSampleSize||0}; lulus ${arm?.passed||0}; gagal kontekstual ${arm?.contextualFailed||0}; teknikal dikecualikan ${arm?.technicalExcluded||0}; tidak diketahui ${arm?.unknown||0}; belum selesai ${arm?.incomplete||0}.`,
        `Kadar kegagalan kontekstual ${percent(arm?.contextualFailureRate)}; kategori relevan ${arm?.relevantFailureCategory||'—'}: ${arm?.relevantFailureCount??'—'} (${percent(arm?.relevantFailureRate)}).`,
        `Feedback kualiti: ${arm?.quality?.reviewedCaptions||0}/${arm?.quality?.eligibleCaptions||0} kandungan; status ${arm?.quality?.statusText||'Belum cukup data'}.`,
      ];
      const confounders=comparison.confounders||{};
      cards[2].append(metricDetails(`Perincian aturan ${comparison.ruleId} versi ${comparison.version}`,[
        ...armLines('Baseline',comparison.baseline),...armLines('Pemerhatian',comparison.observed),
        `Skop kategori/topik ${comparison.productCategory||'all'} / ${comparison.contentTopic||'all'}; co-applied rules ${comparison.coAppliedRules?.map((rule)=>`${rule.ruleId} v${rule.version}`).join(', ')||'tiada'}.`,
        `Confounder: model/config ${confounders.modelOrConfigChanged?'berubah':'tiada perbezaan dikesan'}; fakta ${confounders.factsChanged?'berubah':'tiada perbezaan dikesan'}; panduan ${confounders.guidelinesChanged?'berubah':'tiada perbezaan dikesan'}; validator ${confounders.validatorChanged?'berubah/tidak diketahui':'konsisten'}.`,
        `Penilaian: ${comparison.statusText||'Belum cukup data'}; hasil pemerhatian sahaja, bukan kesan sebab-akibat.`,
      ]));
    }
    target.replaceChildren(...cards);
  }
  async function fetchLearningMetrics() {
    const days=Number($('#learning-metric-range').elements.days.value);
    if(![30,90,365].includes(days)) throw Object.assign(new Error('INVALID_ANALYTICS_WINDOW'),{code:'INVALID_ANALYTICS_WINDOW'});
    const to=new Date();const from=new Date(to.getTime()-days*86400000);
    return api(`/api/learning/metrics?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  }
  let learningNextBeforeId = null;
  let learningCandidateStatus = 'pending';
  let learningCandidateSource = '';
  let learningCandidateSearch = '';
  function learningCandidateUrl(beforeId = null) {
    const params = new URLSearchParams();
    if (learningCandidateStatus) params.set('status', learningCandidateStatus);
    if (learningCandidateSource) params.set('source', learningCandidateSource);
    if (learningCandidateSearch) params.set('q', learningCandidateSearch);
    if (beforeId) params.set('beforeId', beforeId);
    return `/api/learning/candidates?${params.toString()}`;
  }
  function fetchLearningCandidates(beforeId = null) { return api(learningCandidateUrl(beforeId)); }
  function renderShadowRuleOptions(rules) {
    const select=$('#learning-shadow-form').elements.ruleIds;
    const approved=(rules||[]).filter((rule)=>rule.approvalStatus==='approved'&&!rule.superseded);
    select.replaceChildren(...approved.map((rule)=>{const option=learningNode('option',`Aturan ${rule.id} v${rule.version} · ${rule.productCategory}/${rule.contentTopic} · ${rule.active?'aktif':'tidak aktif'}`);option.value=String(rule.id);return option;}));
    const button=$('#learning-shadow-form button[type="submit"]'); button.disabled=state.learningCapabilities?.shadowEnabled!==true||approved.length===0;
  }
  function renderShadowEvaluations(evaluations) {
    const target=$('#learning-shadow-results');
    if (!evaluations.length) { learningEmpty(target,'Belum ada perbandingan shadow.'); return; }
    const dimensions=['hook','creativity','language','relevance','brandVoice','clarity','diversity','cta'];
    target.replaceChildren(...evaluations.map((evaluation)=>{
      const item=document.createElement('article');item.className='learning-item stack';
      const evaluationId=String(evaluation.evaluationId||evaluation.id||'');
      item.append(learningNode('strong',`Evaluation ${evaluationId} · ${evaluation.status} · model ${evaluation.modelId||'—'} · ${learningDate(evaluation.createdAt)}`));
      item.append(learningNode('p',`${evaluation.completedSamples||0}/${evaluation.requestedSamples||0} pasangan · ${evaluation.providerCalls||0} panggilan provider · anggaran maks ${evaluation.estimatedMaxTokens||0} token${evaluation.failureCode?` · ${evaluation.failureCode}`:''}`, 'muted'));
      for(const sample of evaluation.results||[]) {
        item.append(learningNode('h3',`Sampel ${sample.sampleIndex}`));
        for(const variant of ['baseline','learning']) {
          const result=sample[variant]||{}; const block=document.createElement('section');block.className='shadow-variant';
          block.append(learningNode('strong',variant==='baseline'?'Tanpa lesson':'Dengan lesson'),learningNode('p',`Hasil: ${result.outcome||'incomplete'} · deterministik ${result.deterministicOutcome||'—'} · auditor ${result.semanticOutcome||'—'}`,'muted'));
          block.append(learningNode('p',result.validatedCaption||'Output tervalidasi tidak tersedia.','learning-evidence'));
          if(result.outcome==='passed'&&evaluationId) {
            const form=document.createElement('form');form.className='shadow-rating-form';
            const type=learningSelect('Penilaian','feedbackType',[['positive','Positif'],['negative','Negatif']], 'positive');form.append(type.label);
            const ratingFields=[];
            for(const dimension of dimensions){const field=learningSelect(dimension,'rating',[['','Tidak dinilai'],['1','1 · buruk'],['2','2'],['3','3 · memadai'],['4','4'],['5','5 · sangat baik']],'');field.label.className='shadow-rating-field';form.append(field.label);ratingFields.push([dimension,field.select]);}
            const explanationLabel=learningNode('label','Catatan (pilihan)');const explanation=document.createElement('input');explanation.maxLength=300;explanation.setAttribute('aria-describedby','learning-text-data-guidance');explanationLabel.append(explanation);form.append(explanationLabel);
            const save=learningNode('button','Simpan rating','button quiet');save.type='submit';form.append(save);
            form.addEventListener('submit',(event)=>{event.preventDefault();const ratings=Object.fromEntries(ratingFields.filter(([,field])=>field.value).map(([key,field])=>[key,Number(field.value)]));if(!Object.keys(ratings).length){show('#learning-error','Pilih sedikitnya satu dimensi.');return;}learningAction(save,async()=>{await api(`/api/learning/shadow-evaluations/${encodeURIComponent(evaluationId)}/reviews`,{method:'POST',body:JSON.stringify({sampleIndex:sample.sampleIndex,variant,feedbackType:type.select.value,ratings,explanation:explanation.value.trim()})});show('#global-success','Rating shadow tersimpan berasingan daripada maklum balas kandungan diterbitkan.');},'Menyimpan…',form);});
            block.append(form);
          }
          item.append(block);
        }
      }
      return item;
    }));
  }
  async function loadLearning() {
    const [capabilities,candidates,rules,reviews]=await Promise.all([
      api('/api/learning/capabilities'),fetchLearningCandidates(),api('/api/learning/rules'),api('/api/learning/reviews'),
    ]);
    state.learningCapabilities=capabilities;
    const capabilityText=`Capture ${capabilities.captureEnabled?'aktif':'tidak aktif'} · aktivasi ${capabilities.activationEnabled?'aktif':'tidak aktif'} · retrieval ${capabilities.retrievalEnabled?'aktif':'tidak aktif'} · prompt ${capabilities.promptIntegrationEnabled?'aktif':'tidak aktif'} · shadow ${capabilities.shadowEnabled?'aktif':'tidak aktif'}. Kemampuan eksekusi dikawal server.`;
    $('#learning-capability-status').textContent=capabilityText;
    renderLearningCandidates(candidates.candidates||[]);learningNextBeforeId=candidates.nextBeforeId;$('#learning-next').hidden=!learningNextBeforeId;
    renderLearningRules(rules.rules||[]);renderLearningReviews(reviews.reviews||[]);
    const [metricsResult,shadowResult]=await Promise.allSettled([fetchLearningMetrics(),api('/api/learning/shadow-evaluations?limit=10')]);
    renderLearningMetrics(metricsResult.status==='fulfilled'?metricsResult.value:null);
    renderShadowEvaluations(shadowResult.status==='fulfilled'?(shadowResult.value.evaluations||[]):[]);
    if(shadowResult.status==='rejected') $('#learning-shadow-results').replaceChildren(learningNode('p',`Riwayat shadow tidak tersedia: ${errorText(shadowResult.reason)}`,'muted'));
    hide('#learning-error');
  }
  $('#learning-candidate-filter').addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    learningCandidateStatus = form.elements.status.value;
    learningCandidateSource = form.elements.source.value;
    learningCandidateSearch = form.elements.q.value.trim();
    learningNextBeforeId = null;
    return withPending($('button[type="submit"]', form), async () => {
      try {
        const response = await fetchLearningCandidates();
        renderLearningCandidates(response.candidates || []);
        learningNextBeforeId = response.nextBeforeId;
        $('#learning-next').hidden = !learningNextBeforeId;
        hide('#learning-error');
      } catch (error) { show('#learning-error', errorText(error)); }
    }, 'Mencari…', form);
  });
  $('#learning-next').addEventListener('click', (event) => {
    const button = event.currentTarget;
    return withPending(button, async () => {
    try {
      const response = await fetchLearningCandidates(learningNextBeforeId);
      renderLearningCandidates(response.candidates || [], {append:true}); learningNextBeforeId = response.nextBeforeId; button.hidden = !learningNextBeforeId; hide('#learning-error');
    } catch (error) { show('#learning-error', errorText(error)); }
    }, 'Memuat…');
  });
  $('#learning-candidate-dialog').addEventListener('keydown',(event)=>{
    if(event.key!=='Tab')return;
    const dialog=event.currentTarget;
    const focusable=[...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter((element)=>element.getClientRects().length>0);
    if(!focusable.length){event.preventDefault();dialog.focus();return;}
    const first=focusable[0];const last=focusable[focusable.length-1];
    if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}
  });
  $('#learning-candidate-dialog-close').addEventListener('click', () => $('#learning-candidate-dialog').close());
  $('#learning-metric-range').addEventListener('submit',(event)=>{
    event.preventDefault();const form=event.currentTarget;const button=$('button[type="submit"]',form);
    return withPending(button,async()=>{try{renderLearningMetrics(await fetchLearningMetrics());}catch(error){renderLearningMetrics(null);show('#learning-error',errorText(error));}},'Memuat…',form);
  });
  $('#learning-refresh').addEventListener('click', (event) => withPending(event.currentTarget, () => loadLearning().catch((error) => show('#learning-error', errorText(error))), 'Memuat…'));
  $('#learning-shadow-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const form=event.currentTarget; const button=$('button[type="submit"]',form);
    const ruleIds=[...form.elements.ruleIds.selectedOptions].map((option)=>option.value);
    if(!ruleIds.length||ruleIds.length>5){show('#learning-error','Pilih antara 1 hingga 5 aturan yang diluluskan.');return;}
    return learningAction(button,async()=>{
      $('#learning-shadow-results').replaceChildren(learningNode('p','Perbandingan berpasangan sedang berjalan. Tiada slot penerbitan akan dibuat.','muted'));
      const response=await api('/api/learning/shadow-evaluations',{method:'POST',body:JSON.stringify({ruleIds,samples:Number(form.elements.samples.value)})});
      renderShadowEvaluations([response.evaluation]);
      show('#global-success','Shadow evaluation selesai dan kekal terpisah daripada operasi penerbitan.');
      hide('#learning-error');
    },'Menilai…',form);
  });
  $('#learning-feedback-form').addEventListener('submit', (event) => {
    event.preventDefault(); const form = event.currentTarget; const button = $('button[type="submit"]', form);
    const ratings = {}; for (const key of ['hook', 'creativity', 'language', 'relevance', 'brandVoice', 'clarity', 'diversity', 'cta']) { if (form.elements[key].value) ratings[key] = Number(form.elements[key].value); }
    if (!Object.keys(ratings).length) { show('#learning-error', 'Pilih sedikitnya satu penilaian kualitas.'); return; }
    const payload = { slotId: form.elements.slotId.value.trim(), type: form.elements.type.value, ratings, explanation: form.elements.explanation.value.trim() };
    return withPending(button, async () => {
      try { await api('/api/learning/feedback', { method: 'POST', body: JSON.stringify(payload) }); form.reset(); hide('#learning-error'); show('#global-success', 'Umpan balik tersimpan untuk review.'); await loadLearning(); }
      catch (error) { show('#learning-error', errorText(error)); }
    }, 'Menyimpan…', form);
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
