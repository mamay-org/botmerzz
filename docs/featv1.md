# Production-Grade Dynamic Configuration Management BotMerzz

## 0. Authorization & Execution Mode

Saya telah membaca dan menyetujui hasil analisis arsitektur Dynamic Configuration Management BotMerzz yang telah kamu susun sebelumnya.

**STATUS: APPROVED FOR FULL IMPLEMENTATION**

**Arsitektur yang disetujui: Option C — Hybrid Configuration.**

Silakan mulai implementasi seluruh tahapan yang telah direncanakan, dengan mengutamakan:

1. Security & secure-by-default.
2. Data integrity & transactional consistency.
3. Reliability & fault tolerance.
4. Concurrency safety.
5. Idempotency & duplicate prevention.
6. Runtime configuration consistency.
7. Backward compatibility.
8. Maintainability & observability.
9. User experience.
10. Production readiness.

Gunakan praktik engineering standar industri yang relevan dengan arsitektur BotMerzz, khususnya Node.js, MySQL, Docker, OpenRouter, dan Tebar API.

**Jangan berhenti pada analisis atau penyusunan rencana. Saya sudah memberikan persetujuan untuk implementasi.**

Namun, lakukan inspeksi codebase dan verifikasi kondisi aktual terlebih dahulu agar perubahan tetap sesuai dengan source code terbaru dan tidak menimpa pekerjaan yang sudah ada.

---

# 1. Scope & Architectural Decisions

## 1.1 Dynamic Configuration

Hanya tiga konfigurasi berikut yang boleh dikelola melalui dashboard admin:

```dotenv
TEBAR_PROFILE_ID=
TEBAR_ACCOUNT_ID=
OPENROUTER_MODEL=
```

Ketiganya harus dapat diperbarui tanpa mengedit `.env` secara manual atau me-restart Docker container, sejauh memungkinkan secara teknis.

## 1.2 Static Configuration & Secrets

API keys dan secrets lainnya, termasuk kredensial Tebar dan OpenRouter, juga tetap menggunakan penyimpanan server-side yang sudah ada.

**Dilarang menyimpan, mengirim, atau mengekspos secrets tersebut melalui dashboard maupun tabel konfigurasi operasional baru.**

## 1.3 Single Source of Truth

Gunakan MySQL sebagai sumber tunggal konfigurasi operasional aktif setelah proses bootstrap berhasil.

Aturan precedence:

1. Jika konfigurasi valid telah tersedia di MySQL, gunakan nilai MySQL.
2. Jika instalasi lama belum mempunyai konfigurasi MySQL, lakukan bootstrap satu kali dari `.env`.
3. Setelah bootstrap selesai, `.env` tidak boleh menimpa konfigurasi MySQL ketika startup, restart, redeploy, migrasi, ataupun CLI command dijalankan.
4. Jika konfigurasi database tidak tersedia, rusak, atau tidak lengkap setelah bootstrap, jangan diam-diam kembali menggunakan `.env`.
5. Jika database tidak dapat diakses, operasi yang membutuhkan konfigurasi aktif harus gagal secara aman.
6. Jika bootstrap awal tidak lengkap, tampilkan status `NOT_CONFIGURED` dan cegah otomasi melakukan publikasi.

Backend adalah satu-satunya pihak yang menentukan effective configuration.

Dashboard tidak boleh menghitung atau mengasumsikan konfigurasi aktif sendiri.

---

# 2. Initial Codebase Inspection

Sebelum melakukan perubahan, periksa kondisi aktual modul berikut:

- `src/config.js`
- `src/cli.js`
- `src/repository.js`
- `src/dispatcher.js`
- `src/content-service.js`
- `src/providers/tebar.js`
- `src/providers/openrouter.js`
- `src/http/routes/webhooks.js`
- `src/server.js`
- `public/index.html`
- `public/app.js`
- `public/styles.css`
- Database migrations.
- Existing automated tests.
- Docker dan deployment configuration.

Perhatikan temuan analisis sebelumnya:

1. `config.js` membaca konfigurasi dari `.env` ketika startup.
2. `cli.js` dapat menimpa target akun database melalui `setProviderTarget()`.
3. Tebar client menangkap Profile ID ketika client dibuat.
4. OpenRouter client menangkap model ketika client dibuat.
5. Generator dan semantic auditor menggunakan model yang sama.
6. Slot menyimpan Account ID tetapi belum sepenuhnya mempertahankan Profile ID.
7. Webhook masih bergantung pada target akun aktif.

Pastikan temuan tersebut masih berlaku pada source terbaru sebelum melakukan perubahan.

Jangan melakukan refactoring yang tidak relevan atau menimpa perubahan existing.

---

# 3. Database Architecture & Integrity

## 3.1 Configuration Persistence

Implementasikan penyimpanan konfigurasi operasional yang mendukung:

- Active Tebar Profile ID.
- Active Tebar Account ID.
- Active OpenRouter Model.
- Configuration version.
- Configuration status.
- Created/updated timestamp.
- Identitas admin yang melakukan perubahan.
- Configuration history.
- Rollback history.

Pisahkan konfigurasi Tebar dan OpenRouter secara logis agar perubahan model tidak memicu prosedur pergantian akun Threads.

Gunakan schema yang sederhana dan konsisten dengan desain database BotMerzz.

## 3.2 Data Integrity

Terapkan:

- Database constraints.
- Transactional updates.
- Row-level locking jika diperlukan.
- Optimistic concurrency control.
- Foreign keys jika relevan.
- Unique constraints untuk mencegah konflik konfigurasi.
- Strict server-side validation.

`TEBAR_PROFILE_ID` dan `TEBAR_ACCOUNT_ID` harus diperlakukan sebagai pasangan konfigurasi yang diubah secara atomik.

Perubahan hanya salah satu nilai tidak boleh menghasilkan kombinasi target yang tidak tervalidasi.

## 3.3 Configuration Versioning

Setiap perubahan konfigurasi harus menghasilkan versi yang dapat ditelusuri.

Pastikan:

1. Versi baru tidak menimpa riwayat sebelumnya.
2. Concurrent update tidak menyebabkan lost update.
3. API menggunakan expected version.
4. Konflik versi menghasilkan HTTP `409 Conflict`.
5. Dashboard meminta admin memuat konfigurasi terbaru ketika terjadi konflik.
6. Rollback mengaktifkan kembali nilai dari versi sebelumnya sebagai versi baru.
7. Rollback tunduk pada validasi dan mekanisme aktivasi yang sama seperti perubahan biasa.

Audit trail harus mencatat perubahan tanpa menyimpan secrets.

## 3.4 Migration Safety

Gunakan migration baru yang:

- Non-destructive.
- Backward-compatible.
- Aman terhadap data existing.
- Aman ketika dijalankan ulang.
- Tidak menghapus riwayat postingan.
- Tidak menimpa konfigurasi production.
- Memiliki prosedur recovery jika gagal.

Evaluasi strategi expand-and-contract jika dibutuhkan.

Pastikan deployment tidak menjalankan aplikasi yang membutuhkan skema baru sebelum migration berhasil.

Jelaskan apabila terdapat bagian migrasi yang tidak dapat sepenuhnya transactional karena perilaku DDL MySQL.

## 3.5 Atomic Bootstrap

Bootstrap dari `.env` hanya boleh dilakukan jika konfigurasi MySQL belum pernah diinisialisasi.

Pastikan:

- Aman ketika beberapa instance startup bersamaan.
- Tidak mengalami race condition.
- Idempotent.
- Tidak menimpa konfigurasi dashboard.
- Tidak membuat konfigurasi setengah lengkap.
- Dapat didiagnosis apabila gagal.

---

# 4. Configuration Service

Implementasikan configuration service yang bertanggung jawab untuk:

1. Membaca konfigurasi aktif dari MySQL.
2. Memvalidasi integritas konfigurasi.
3. Menyediakan immutable configuration snapshot.
4. Mengelola configuration version.
5. Menangani update dan rollback.
6. Mencegah stale configuration.
7. Mengelola state pergantian akun.
8. Menyediakan informasi konfigurasi efektif untuk API dan dashboard.

Untuk MVP, prioritaskan pembacaan MySQL pada awal pekerjaan dan pada endpoint yang membutuhkan konfigurasi.

Jangan menambahkan cache terdistribusi atau Redis kecuali benar-benar diperlukan.

Jika menggunakan cache, wajib menjelaskan dan menguji mekanisme invalidation serta konsistensi antar-instance.

Jangan menyimpan konfigurasi runtime hanya dalam variabel global mutable.

---

# 5. Tebar Account Switching — Critical Integrity Requirements

Bagian ini merupakan prioritas paling kritis karena kesalahan dapat menyebabkan postingan dipublikasikan ke akun Threads yang salah.

## 5.1 Atomic Account Identity

Perlakukan:

```dotenv
TEBAR_PROFILE_ID=
TEBAR_ACCOUNT_ID=
```

sebagai satu identitas target publikasi.

Perubahan harus dilakukan dan diaktifkan secara atomik.

## 5.2 Provider Validation

Sebelum aktivasi:

1. Validasi pasangan Profile ID dan Account ID melalui API Tebar.
2. Pastikan Account ID termasuk dalam Profile ID tersebut.
3. Pastikan akun merupakan akun Threads.
4. Pastikan akun berada dalam status yang memungkinkan publikasi.
5. Pastikan API key memiliki hak untuk mengakses profile.
6. Periksa status suspended atau disconnected jika tersedia.
7. Ambil identitas akun yang dapat ditampilkan di dashboard.

Jika validasi gagal, timeout, tidak memiliki izin, atau hasilnya ambigu, pertahankan konfigurasi lama.

Validasi provider tidak boleh dianggap sebagai jaminan bahwa publikasi berikutnya pasti berhasil.

## 5.3 Safe Switching State Machine

Implementasikan proses pergantian akun dengan state yang jelas dan persisten, misalnya:

- `ACTIVE`
- `SWITCHING`
- `BLOCKED_RECONCILIATION`
- `PAUSED`
- `NOT_CONFIGURED`

Sesuaikan nama dan struktur state dengan arsitektur existing agar tidak menciptakan state yang redundan.

Transisi state harus dapat diaudit, aman terhadap concurrent request, dan tetap konsisten setelah restart.

## 5.4 Switching Workflow

Gunakan alur berikut:

1. Admin mengajukan perubahan pasangan akun.
2. Backend melakukan validasi input.
3. Backend memverifikasi pasangan akun melalui Tebar.
4. Admin memperoleh konfirmasi identitas akun tujuan.
5. Sistem memulai switching secara terkoordinasi.
6. Semua dispatcher menghentikan klaim slot baru secara atomik.
7. Slot yang belum dipublikasikan ditangani berdasarkan state dan session asalnya.
8. Slot in-flight direkonsiliasi menggunakan identitas akun lama.
9. Jika ada status publikasi yang belum pasti, switching ditahan.
10. Jika seluruh kondisi aman, aktifkan pasangan baru dalam transaksi database.
11. Buat automation session baru jika diperlukan.
12. Pertahankan automation dalam kondisi OFF/PAUSED.
13. Tampilkan status sukses hanya setelah database mengonfirmasi aktivasi.
14. Admin mengaktifkan automation kembali secara eksplisit.

Jangan otomatis melakukan live posting setelah perubahan akun berhasil.

## 5.5 Slot Identity Snapshot

Setiap slot baru harus mempertahankan:

- Configuration version.
- Tebar Profile ID.
- Tebar Account ID.
- Payload.
- Idempotency key.
- Automation session identity jika tersedia.

Gunakan snapshot tersebut untuk:

- Publishing.
- Status checking.
- Cancellation.
- Webhook reconciliation.
- Retry.
- Recovery setelah restart.

Jangan membaca target akun global terbaru ketika memproses slot lama.

## 5.6 Slot State Handling

Tangani secara eksplisit:

- `pending`
- `generating`
- `ready`
- `publishing`
- `unknown`
- `published`
- `failed`
- `cancelled`

Untuk setiap status:

- Tentukan tindakan yang aman selama account switching.
- Pertahankan data historis.
- Jangan memindahkan slot antar-akun.
- Jangan mengubah payload siap publikasi secara diam-diam.
- Jangan mengirim ulang request dengan hasil yang belum pasti.
- Jangan menganggap timeout sebagai bukti bahwa publikasi gagal.

Slot yang sudah diterima Tebar tetap menjadi bagian dari riwayat akun asalnya meskipun konfigurasi aktif berubah.

## 5.7 Concurrency & Distributed Coordination

Pastikan perubahan akun dan publishing tidak mengalami race condition.

Gunakan mekanisme MySQL yang sesuai, seperti:

- Row-level locking.
- Transactions.
- Conditional state updates.
- Version checks.
- Lease atau fencing jika diperlukan.

Jangan hanya menggunakan in-memory mutex.

Pastikan:

1. Dua dispatcher tidak mengklaim slot yang sama secara tidak aman.
2. Proses switching tidak melewati proses publishing yang sudah dimulai.
3. Dispatcher yang menggunakan state lama tidak dapat mengirim ke akun yang salah.
4. Restart tidak membuat switching kehilangan state.
5. Seluruh instance menghormati status switching.

**Jangan menahan transaksi database tetap terbuka selama melakukan HTTP request ke Tebar.**

Jika diperlukan, gunakan lease, fencing token, atau mekanisme koordinasi lain yang mampu menjaga keselamatan proses selama panggilan eksternal.

Jelaskan batas jaminan mekanisme tersebut, terutama jika provider tidak mendukung fencing atau idempotency secara native.

## 5.8 Crash Consistency & Idempotency

Evaluasi celah kegagalan antara:

1. Slot dibuat.
2. Payload disimpan.
3. Slot diklaim.
4. Request dikirim ke Tebar.
5. Provider menerima request.
6. Respons diterima.
7. Status database diperbarui.

Pastikan crash atau timeout tidak menyebabkan postingan dikirim dua kali secara otomatis.

Gunakan idempotency key yang stabil sesuai kemampuan Tebar.

Jika API provider tidak menjamin idempotency, jangan mengklaim exactly-once publishing.

Evaluasi penggunaan transactional outbox atau pola setara hanya jika diperlukan untuk menutup celah pada mekanisme existing.

Untuk hasil publikasi yang ambigu:

- Simpan status `unknown` atau status setara.
- Jangan melakukan blind retry.
- Rekonsiliasi melalui API provider jika memungkinkan.
- Jika tidak dapat dipastikan, minta tindakan operasional admin.
- Jangan mengorbankan integritas publikasi demi memastikan slot selalu berhasil.

## 5.9 Reconciliation & Recovery

Implementasikan prosedur yang aman ketika:

- Request timeout.
- Provider error.
- Respons hilang.
- Provider post ID tidak tersedia.
- Webhook terlambat.
- Server restart.
- Database sempat unavailable.
- Switching terhenti di tengah proses.

Reconciliation harus menggunakan identitas akun dari slot asal.

Proses recovery tidak boleh melakukan re-publication yang dapat menimbulkan duplikasi.

---

# 6. Webhook Security & Reliability

Audit dan sesuaikan webhook Tebar agar tidak bergantung pada akun aktif global.

Persyaratan:

1. Gunakan identitas slot dan akun asal.
2. Verifikasi keaslian webhook menggunakan metode yang didukung Tebar.
3. Terapkan replay protection jika provider menyediakan informasi atau mekanisme yang memadai.
4. Tangani duplicate events secara idempotent.
5. Tangani out-of-order events.
6. Tangani delayed webhooks dari akun lama.
7. Jangan membiarkan event lama merusak status slot baru.
8. Jangan mempercayai account ID atau status dari payload tanpa pemeriksaan yang sesuai.
9. Batasi informasi sensitif pada logs dan error responses.

Jika Tebar tidak menyediakan fitur tertentu, dokumentasikan keterbatasannya dan gunakan mitigasi yang relevan.

Jangan mengarang atau mengasumsikan adanya webhook signature yang tidak didukung provider.

---

# 7. OpenRouter Dynamic Model Configuration

## 7.1 Model Selection

Implementasikan pengaturan:

```dotenv
OPENROUTER_MODEL=
```

melalui dashboard.

Sediakan dropdown model yang dapat dicari, menggunakan metadata OpenRouter jika memungkinkan.

Izinkan input manual model ID sebagai fallback apabila katalog model tidak tersedia, tetapi tetap lakukan validasi di backend sebelum aktivasi.

## 7.2 Model Validation

Sebelum aktivasi:

- Validasi format model ID.
- Batasi panjang input.
- Verifikasi metadata model melalui OpenRouter.
- Pastikan model mendukung text input dan text output.
- Pastikan kompatibel dengan parameter aplikasi.
- Periksa dukungan parameter seperti `temperature` dan `top_p` jika digunakan.
- Bedakan model tidak valid, model tidak kompatibel, dan provider sementara tidak tersedia.

Jangan menganggap metadata sebagai bukti bahwa model pasti berhasil menjalankan semantic audit.

## 7.3 Runtime Model Snapshot

Perubahan model hanya berlaku untuk generasi baru.

Ketentuan:

1. Baca model aktif ketika proses generasi dimulai.
2. Gunakan snapshot model yang konsisten selama satu proses generasi dan semantic audit.
3. Jangan mengubah model di tengah proses yang sudah berjalan.
4. Jangan melakukan re-generation pada slot ready.
5. Jangan mengubah payload atau idempotency key yang sudah disimpan.
6. Jika model baru tidak tersedia saat runtime, gunakan mekanisme retry dan fail-safe existing.
7. Jangan melakukan fallback model otomatis tanpa kebijakan yang telah disetujui.
8. Jangan pernah melewati semantic auditor untuk menjaga tingkat keberhasilan publikasi.

Konfigurasi model tidak boleh memengaruhi session switching akun Threads.

---

# 8. Backend API & Security

Implementasikan endpoint konfigurasi dengan mengikuti prinsip OWASP dan secure-by-default.

## 8.1 Authentication & Authorization

- Hanya administrator yang terautentikasi dapat membaca atau mengubah konfigurasi.
- Terapkan authorization di backend untuk setiap endpoint.
- Jangan mengandalkan penyembunyian tombol di frontend.
- Terapkan least privilege.
- Pastikan session handling dan cookie security sesuai arsitektur existing.

## 8.2 Input Validation

- Gunakan strict schema validation.
- Tolak unknown fields.
- Validasi tipe dan panjang input.
- Validasi identifier Tebar.
- Validasi OpenRouter model ID.
- Gunakan parameterized SQL queries.
- Hindari mass assignment.
- Pastikan semua error ditangani secara aman.

## 8.3 CSRF & Request Security

- Terapkan CSRF protection sesuai mekanisme autentikasi.
- Evaluasi Origin validation.
- Gunakan cookie `Secure`, `HttpOnly`, dan `SameSite` jika relevan.
- Terapkan rate limiting proporsional untuk endpoint sensitif.
- Hindari kebocoran internal error dan stack trace.

## 8.4 Concurrency Control

Gunakan expected configuration version pada request perubahan.

Jika versi tidak cocok:

- Tolak update.
- Kembalikan HTTP `409 Conflict`.
- Jangan mengubah konfigurasi.
- Berikan informasi aman agar dashboard dapat meminta admin memuat ulang data.

## 8.5 Audit Trail

Catat:

- Actor/admin.
- Timestamp.
- Configuration version.
- Jenis perubahan.
- Status validasi.
- Hasil aktivasi.
- Alasan kegagalan yang aman untuk dicatat.

Jangan mencatat:

- API key.
- Bot token.
- Authorization headers.
- Password.
- Secrets lainnya.

---

# 9. Dashboard UI/UX

Implementasikan antarmuka pengaturan integrasi yang konsisten dengan dashboard BotMerzz.

## 9.1 Tebar Configuration

Dashboard menampilkan:

- Active Profile ID.
- Active Account ID.
- Username akun Threads.
- Status akun.
- Status verifikasi provider.
- Automation status.
- Tombol validasi akun.
- Tombol konfirmasi pergantian akun.
- Informasi risiko terhadap pending jobs.
- Status switching dan reconciliation.

Admin harus mengetahui akun tujuan sebelum menyetujui perubahan.

## 9.2 OpenRouter Configuration

Dashboard menyediakan:

- Current active model.
- Searchable model dropdown.
- Manual model ID fallback.
- Validasi kompatibilitas.
- Informasi apabila model tidak tersedia.
- Konfirmasi keberhasilan perubahan.

## 9.3 Configuration History & Rollback

Sediakan:

- Riwayat perubahan.
- Waktu perubahan.
- Administrator yang melakukan perubahan.
- Nilai konfigurasi sebelumnya.
- Status perubahan.
- Tombol rollback dengan konfirmasi.

Rollback akun Tebar harus mengikuti seluruh prosedur safe switching.

Rollback model harus mengikuti model validation.

## 9.4 User Experience

Pastikan:

- Responsive desktop dan mobile.
- Accessible labels.
- Keyboard navigation.
- Loading states.
- Success/error feedback.
- Field-level validation.
- Confirmation dialog.
- Double submission prevention.
- Conflict handling.
- Empty states.
- Pending reconciliation states.
- Data input tidak hilang ketika validasi gagal.

Dashboard tidak boleh menampilkan keberhasilan sebelum backend mengonfirmasi perubahan.

Jangan melakukan redesign global di luar scope.

---

# 10. Observability & Operational Recovery

Implementasikan observability yang memadai untuk debugging dan maintenance.

Gunakan structured logging dan correlation ID pada operasi:

- Configuration read.
- Configuration update.
- Account validation.
- Account switching.
- Model validation.
- Publishing.
- Webhook.
- Reconciliation.
- Rollback.

Sertakan identifier yang relevan:

- Configuration version.
- Slot ID.
- Automation session.
- Provider account/profile ID.
- Request correlation ID.

Jangan mencatat secrets atau payload sensitif tanpa kebutuhan.

Pastikan admin dapat memahami:

1. Konfigurasi mana yang aktif.
2. Apakah account switching sedang berlangsung.
3. Apakah terdapat post yang belum direkonsiliasi.
4. Apa penyebab konfigurasi gagal diaktifkan.
5. Apakah otomasi aman untuk diaktifkan kembali.

Dokumentasikan prosedur manual recovery apabila provider tidak tersedia atau switching terhenti.

---

# 11. Testing Strategy

Pengujian harus membuktikan correctness, bukan sekadar code coverage.

## 11.1 Configuration & Database Tests

Uji:

- First-time bootstrap.
- Repeated bootstrap.
- Concurrent startup.
- Existing database migration.
- Restart.
- Redeploy.
- Invalid configuration.
- Database unavailable.
- Configuration update.
- Configuration version conflict.
- Configuration rollback.
- Audit history integrity.

## 11.2 Tebar Switching Tests

Uji:

- Valid account/profile.
- Invalid account/profile.
- Unauthorized profile.
- Disconnected/suspended account.
- Switching ketika automation aktif.
- Switching dengan pending slots.
- Switching dengan ready slots.
- Switching saat publishing berlangsung.
- Unknown publication.
- Missing provider post ID.
- Provider timeout.
- Late webhook.
- Duplicate webhook.
- Out-of-order webhook.
- Restart di tengah switching.
- Concurrent switching requests.
- Multiple dispatcher instances.
- Rollback ke akun sebelumnya.
- Tidak ada publikasi ke akun yang salah.

## 11.3 Fault Injection & Crash Recovery

Simulasikan:

1. Crash setelah slot diklaim.
2. Crash sebelum request Tebar dikirim.
3. Crash setelah request terkirim tetapi sebelum respons diterima.
4. Crash setelah respons diterima tetapi sebelum status database diperbarui.
5. Database unavailable ketika publishing.
6. Provider timeout ketika switching.
7. Restart ketika status `SWITCHING`.
8. Dua dispatcher melakukan klaim slot bersamaan.
9. Webhook datang setelah target akun berubah.

Pastikan sistem tetap fail-safe.

## 11.4 OpenRouter Tests

Uji:

- Valid model.
- Invalid model.
- Unsupported model.
- Metadata unavailable.
- Rate limit.
- Provider timeout.
- Model switching selama generation.
- Model switching selama semantic audit.
- Generator/auditor snapshot consistency.
- Preservation of ready payload.
- No silent model fallback.

## 11.5 Security Tests

Uji:

- Unauthorized access.
- Insufficient privileges.
- CSRF.
- Invalid Origin jika relevan.
- Invalid payload.
- Mass assignment.
- SQL Injection prevention.
- Parameter tampering.
- Replay request.
- Concurrent update.
- Sensitive data exposure.

## 11.6 Regression Tests

Pastikan fitur existing tetap berjalan:

- Automation ON/OFF.
- Immediate posting pada reactivation sesuai aturan existing.
- Scheduler reset.
- Full-Caption Generator.
- Creative Direction.
- Topic Rotation.
- Semantic Auditor.
- Fact validation.
- Retry logic.
- Tebar publishing.
- Webhook processing.
- Telegram notification.
- Docker startup.
- CLI commands.
- Dashboard settings.

Jalankan:

- `npm test`.
- `npm audit`.
- Docker/MySQL integration tests jika tersedia.
- Lint/type checks jika tersedia.
- Build verification jika relevan.

Gunakan mock provider atau environment testing yang benar-benar terisolasi.

**Dilarang melakukan live posting ke Threads selama pengujian.**

---

# 12. Implementation Phases

Laksanakan implementasi secara bertahap.

| Phase | Scope | Expected Result |
|---|---|---|
| 1 | Database migration & bootstrap | Konfigurasi persisten dan aman |
| 2 | Configuration service | Single source of truth |
| 3 | Backend API & security | Konfigurasi hanya dapat diubah admin |
| 4 | Provider validation | Tebar/OpenRouter tervalidasi |
| 5 | Safe account switching | Tidak ada salah target publikasi |
| 6 | Model snapshot integration | Perubahan model konsisten |
| 7 | Webhook & reconciliation | Riwayat akun lama tetap aman |
| 8 | Dashboard & rollback | Admin dapat mengelola konfigurasi |
| 9 | Tests & fault injection | Correctness terverifikasi |
| 10 | Documentation & final review | Implementasi dapat diaudit |

Untuk setiap fase:

1. Implementasikan perubahan yang diperlukan.
2. Tambahkan atau perbarui automated tests.
3. Jalankan pengujian relevan.
4. Perbaiki error atau regresi.
5. Pastikan perubahan kompatibel dengan fase berikutnya.

Jangan berhenti setelah satu fase apabila fase lainnya masih berada dalam scope yang disetujui.

---

# 13. Production Safety Boundaries

Saya mengizinkan:

- Perubahan source code.
- Penambahan migration non-destruktif.
- Refactoring yang relevan.
- Pembuatan API.
- Pengembangan dashboard.
- Automated tests.
- Pengujian Docker lokal.
- Pembaruan dokumentasi.

Saya tidak mengizinkan:

- Deployment production.
- Perubahan `.env` production.
- Perubahan API keys atau secrets.
- Live publishing ke Threads.
- Perubahan konfigurasi aktif pada VPS production.
- Destructive migration.
- Penghapusan data existing.
- Penonaktifan guardrail keamanan untuk meloloskan pengujian.

Jika pengujian dengan API pihak ketiga diperlukan, hanya gunakan environment yang telah diverifikasi aman dan terisolasi.

Jangan mengasumsikan staging aman jika masih menggunakan kredensial atau akun production.

---

# 14. Acceptance Criteria / Definition of Done

Implementasi dianggap selesai apabila seluruh kriteria berikut terpenuhi:

### Configuration

- [ ] Ketiga konfigurasi tersedia di dashboard.
- [ ] Konfigurasi disimpan secara persisten di MySQL.
- [ ] `.env` hanya digunakan untuk bootstrap awal.
- [ ] Restart/redeploy tidak menimpa konfigurasi database.
- [ ] API keys dan Telegram tetap di `.env`.
- [ ] Update konfigurasi memiliki versioning dan audit trail.
- [ ] Rollback aman dan tervalidasi.

### Tebar

- [ ] Profile ID dan Account ID diaktifkan secara atomik.
- [ ] Account validation berjalan.
- [ ] Tidak ada slot lama yang berpindah akun.
- [ ] Tidak ada dispatch menggunakan target global yang salah.
- [ ] Slot publishing dan unknown direkonsiliasi dengan aman.
- [ ] Webhook lama tetap diproses sesuai akun asal.
- [ ] Concurrent switching ditangani.
- [ ] Restart tidak merusak switching state.
- [ ] Tidak ada blind retry untuk hasil publikasi ambigu.
- [ ] Automation tetap OFF setelah switching.
- [ ] Reaktivasi automation mengikuti aturan scheduler existing.

### OpenRouter

- [ ] Model dapat diubah melalui dashboard.
- [ ] Model tervalidasi sebelum aktivasi.
- [ ] Perubahan berlaku untuk generasi berikutnya.
- [ ] Generator dan auditor konsisten dalam satu slot.
- [ ] Slot ready tidak dimodifikasi.
- [ ] Tidak ada silent fallback atau bypass semantic audit.

### Security

- [ ] Authentication dan authorization terverifikasi.
- [ ] CSRF protection sesuai arsitektur.
- [ ] Strict backend validation.
- [ ] Parameterized SQL queries.
- [ ] Concurrency conflict handling.
- [ ] Tidak ada kebocoran secrets.
- [ ] Audit logging aman.

### Reliability

- [ ] Fault injection tests selesai.
- [ ] Crash recovery diuji.
- [ ] Idempotency dan duplicate prevention diuji.
- [ ] Database failure ditangani secara aman.
- [ ] Provider timeout ditangani secara aman.
- [ ] Tidak ada regresi yang teridentifikasi pada fitur existing.

### Documentation

- [ ] Arsitektur final terdokumentasi.
- [ ] Migration dan bootstrap terdokumentasi.
- [ ] State transition terdokumentasi.
- [ ] Account switching terdokumentasi.
- [ ] Rollback dan recovery terdokumentasi.
- [ ] Test evidence tersedia.
- [ ] Keterbatasan provider dan risiko tersisa dijelaskan.

**Jika ada acceptance criteria yang belum dapat diverifikasi, tandai sebagai `PENDING VERIFICATION`, bukan dianggap selesai.**

---

# 15. Final Deliverables

Setelah implementasi, berikan laporan akhir yang mencakup:

1. Executive summary.
2. Arsitektur final.
3. Daftar modul/file yang berubah.
4. Migration yang dibuat.
5. Penjelasan bootstrap dan konfigurasi efektif.
6. Mekanisme account switching.
7. Mekanisme locking, concurrency, dan idempotency.
8. Mekanisme webhook dan reconciliation.
9. Mekanisme OpenRouter model switching.
10. Perubahan UI/UX dashboard.
11. API endpoints yang ditambahkan atau diubah.
12. Hasil automated tests (passed, failed, skipped).
13. Hasil security dan fault-injection tests.
14. Hasil Docker integration tests.
15. Known limitations dan residual risks.
16. Prosedur backup, rollback, dan recovery.
17. Checklist staging verification.
18. Status kesiapan untuk deployment.

Gunakan status akhir yang jelas:

- `IMPLEMENTED & VERIFIED`
- `IMPLEMENTED — PENDING STAGING VERIFICATION`
- `BLOCKED`

Jangan menyatakan `PRODUCTION READY` tanpa bukti pengujian staging yang memadai dan verifikasi konfigurasi runtime sebenarnya.

---

# 16. Final Instruction

**Mulai implementasi sekarang berdasarkan rancangan arsitektur yang telah disetujui.**

Jangan mengulang fase diskusi atau meminta persetujuan tambahan untuk keputusan teknis rutin dalam scope.

Selesaikan seluruh pekerjaan yang memungkinkan dilakukan dalam codebase dan lingkungan pengujian yang tersedia.

Jika ada keterbatasan dari API pihak ketiga atau lingkungan testing, dokumentasikan secara jelas dan jangan membuat klaim keberhasilan yang tidak dapat dibuktikan.

**Prioritaskan correctness, security, data integrity, concurrency safety, operational reliability, dan maintainability di atas kecepatan implementasi.**

Target akhir adalah Dynamic Configuration Management BotMerzz yang dapat dikelola klien melalui dashboard, aman terhadap perubahan akun, konsisten saat runtime, dan tidak merusak automation maupun publishing workflow yang sudah berjalan.