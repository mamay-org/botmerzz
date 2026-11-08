'use strict';

const { DateTime } = require('luxon');

const MAX_MESSAGE = 4096;
const FAILURES = {
  generation_failed: 'AI tidak berhasil menghasilkan konten yang dapat diterbitkan.',
  content_validation_failed: 'Konten tidak memenuhi aturan validasi.',
  invalid_settings: 'Pengaturan konten belum valid.',
  approved_content_invalid: 'Informasi produk yang disetujui tidak valid.',
  onboarding_incomplete: 'Pengaturan awal belum lengkap.',
  ai_not_configured: 'Penyedia AI belum dikonfigurasi.',
  ai_unauthorized: 'Penyedia AI menolak autentikasi.',
  ai_rate_limited: 'Penyedia AI sedang membatasi permintaan.',
  ai_network_error: 'Penyedia AI tidak dapat dihubungi.',
  ai_provider_error: 'Penyedia AI mengalami gangguan.',
  ai_invalid_response: 'Penyedia AI mengirim respons yang tidak dapat digunakan.',
  stale_facts: 'Informasi atau pengaturan berubah sebelum publikasi.',
  stale_generation: 'Pembuatan konten melewati batas waktu.',
  provider_error: 'Penyedia publikasi melaporkan kegagalan.',
  rate_limited: 'Penyedia publikasi sedang membatasi permintaan.',
  unauthorized: 'Penyedia publikasi menolak autentikasi.',
  account_disconnected: 'Akun Threads tidak terhubung.',
  account_expired: 'Koneksi akun Threads telah kedaluwarsa.',
  network_error: 'Penyedia publikasi tidak dapat dihubungi.',
};
const CATEGORY = { topup: 'Top-up', account: 'Jual akun' };
function safe(value, limit = 500) {
  return typeof value === 'string' ? Array.from(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()).slice(0, limit).join('') : '';
}
function dateTime(value, zone = 'Asia/Kuala_Lumpur', dateOnly = false) {
  if (!value) return '';
  const dt = value instanceof Date ? DateTime.fromJSDate(value) : DateTime.fromISO(String(value), { setZone: true });
  const local = dt.setZone(zone);
  return local.isValid ? local.setLocale('id').toFormat(dateOnly ? 'd LLLL yyyy' : 'd LLLL yyyy, HH:mm ZZZZ') : '';
}
function verifiedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'].includes(url.hostname.toLowerCase()) ? url.href : '';
  } catch { return ''; }
}
function bounded(body, reference) {
  const suffix = reference ? `\n\n⸻\n\nTechnical Reference\n${reference}` : '';
  const room = Math.max(0, MAX_MESSAGE - suffix.length);
  return `${body.length > room ? body.slice(0, Math.max(0, room - 1)).trimEnd() + '…' : body}${suffix}`;
}
function formatSlotNotice({ status, slotId, brand, time, timezone, pillar, caption, postUrl, nextAt, reason, diagnosticCode } = {}) {
  const ok = status === 'published';
  const pending = status === 'unknown' || status === 'publishing' || status === 'pending_verification';
  const title = ok ? 'BOTMERZZ — POSTING BERHASIL' : pending ? 'BOTMERZZ — STATUS POSTING DIPERIKSA' : 'BOTMERZZ — POSTING GAGAL';
  const state = ok ? 'Status: Berhasil diterbitkan' : pending ? 'Status: Menunggu konfirmasi publikasi' : 'Status: Gagal diterbitkan';
  const parts = [title, `Brand: ${safe(brand, 100) || 'Kedai Merzz'}\nPlatform: Threads\n${state}`];
  const stamp = dateTime(time, timezone);
  if (stamp) parts.push(`${ok ? 'Waktu publikasi' : 'Waktu percobaan'}: ${stamp}`);
  if (ok) {
    if (CATEGORY[pillar]) parts.push(`Kategori: ${CATEGORY[pillar]}`);
    if (safe(caption)) parts.push(`Isi Postingan:\n${safe(caption)}`);
    const link = verifiedUrl(postUrl);
    if (link) parts.push(`Lihat Postingan:\n${link}`);
  } else if (pending) {
    parts.push('Status akhir publikasi belum dapat dipastikan.\n\nTindakan Sistem:\nMenunggu pemeriksaan status; sistem tidak mengirim ulang secara otomatis untuk mencegah duplikasi.');
  } else {
    parts.push(`Penyebab:\n${FAILURES[diagnosticCode] || FAILURES[reason] || 'Penyebab kegagalan belum dapat ditentukan.'}\n\nTindakan Sistem:\nKegagalan dicatat; sistem mengikuti jadwal otomasi yang berlaku.`);
  }
  const next = dateTime(nextAt, timezone);
  if (next && !pending) parts.push(`${ok ? 'Posting Berikutnya' : 'Jadwal Berikutnya'}:\n${next}`);
  return bounded(parts.join('\n\n'), slotId ? `Slot ID: ${safe(String(slotId), 36)}` : '');
}
function formatDailyReport({ brand, date, timezone = 'Asia/Kuala_Lumpur', published = 0, failed = 0, unknown = 0, categories, failures, automationEnabled, nextAt, affectedSlotIds = [] } = {}) {
  const total = published + failed;
  const parts = ['BOTMERZZ — LAPORAN HARIAN', `Brand: ${safe(brand, 100) || 'Kedai Merzz'}${dateTime(date, timezone, true) ? `\nTanggal: ${dateTime(date, timezone, true)}` : ''}\nTimezone: ${safe(timezone, 60)}`,
    `Ringkasan Publikasi\nBerhasil: ${published} posting\nGagal: ${failed} posting\nBelum pasti: ${unknown} posting\nSuccess Rate: ${total ? `${Math.round(published / total * 100)}%` : 'Belum tersedia'}`];
  if (categories && typeof categories === 'object') {
    const list = Object.entries(categories).filter(([key, count]) => CATEGORY[key] && Number.isInteger(count) && count > 0).map(([key, count]) => `• ${CATEGORY[key]}: ${count} posting`);
    if (list.length) parts.push(`Kategori Konten\n${list.join('\n')}`);
  }
  if (Array.isArray(failures) && failures.length) parts.push(`Ringkasan Kendala\n${failures.slice(0, 4).map(({ code, count }) => `${count} posting: ${FAILURES[code] || 'Penyebab kegagalan belum dapat ditentukan.'}`).join('\n')}`);
  if (typeof automationEnabled === 'boolean') parts.push(`Status Otomasi: ${automationEnabled ? 'Aktif' : 'Nonaktif'}`);
  const next = automationEnabled === true && dateTime(nextAt, timezone);
  if (next) parts.push(`Posting Berikutnya:\n${next}`);
  const allIds = [...new Set(affectedSlotIds.filter((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)))];
  const ids = allIds.slice(0, 8);
  const reference = ids.map((id) => `Slot ID: ${id}`);
  if (allIds.length > ids.length) reference.push(`${allIds.length - ids.length} Slot ID lainnya tersedia di log.`);
  return bounded(parts.join('\n\n'), reference.join('\n'));
}
module.exports = { formatSlotNotice, formatDailyReport };
