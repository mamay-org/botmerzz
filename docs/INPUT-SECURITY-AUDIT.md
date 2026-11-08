# Audit Keamanan Input BotMerzz

Tanggal audit awal: 8 November 2026

Tanggal verifikasi remediasi: 9 November 2026

Revisi yang diperiksa: branch `codex/creative-content-variation`, commit `bb4f580`
Metode: inspeksi statis route, middleware, validasi, autentikasi, repository, webhook, serta rendering frontend. Tidak ada perubahan source, database, atau konfigurasi.

## Ringkasan eksekutif

Tidak ditemukan kerentanan Critical atau High yang terkonfirmasi pada source yang diperiksa. Tidak ada bukti SQL injection, stored/reflected XSS, bypass CSRF, command injection, SSRF, atau endpoint mutasi tanpa autentikasi pada jalur yang diaudit. Banyak kontrol dasar sudah tersedia: validasi server-side, query parameterized, session cookie HttpOnly/SameSite, pemeriksaan Origin dan CSRF, batas ukuran JSON, verifikasi signature webhook, serta penggunaan output DOM yang aman.

Semua temuan SEC-01 sampai SEC-03 telah diperbaiki dan diuji. Rate limit login kini tersimpan bersama di MySQL, atomik lintas instance, menggunakan jendela tetap 15 menit, dan mengembalikan waktu tunggu yang tersisa. CTA dibatasi ke domain resmi dan readiness publik hanya mengembalikan status minimal.

Audit awal tidak membuktikan keamanan runtime atau deployment. Remediasi berikutnya menjalankan test otomatis dan smoke test terbatas pada Docker lokal; konfigurasi reverse proxy/VPS, akun staging, dan provider eksternal belum diverifikasi.

## Cakupan entry point

- Sesi/admin: login tidak memerlukan sesi dan dilindungi pemeriksaan same-origin serta throttling login; logout dan mutasi dashboard/admin memerlukan sesi dan pemeriksaan CSRF. Webhook Tebar memakai verifikasi signature.
- Pengaturan dashboard, jadwal, fakta produk, automation dan template: divalidasi pada backend sebelum penyimpanan.
- Parameter URL: `service` pada fakta, ID admin/template, dan identifier terkait diproses di route masing-masing.
- Header: cookie session, Origin, token CSRF, serta signature webhook.
- Webhook Tebar: route didaftarkan sebelum JSON parser agar signature dapat diverifikasi atas raw body; request JSON dibatasi 256 KB.
- Telegram: integrasi yang ditinjau mengirim notifikasi keluar; tidak ditemukan endpoint inbound Telegram.
- File upload: tidak ditemukan jalur upload file pada aplikasi yang ditinjau.
- Shell/process execution: tidak ditemukan penggunaan `child_process` pada jalur aplikasi dashboard yang ditinjau.

## Temuan keamanan

### SEC-01 — Pembatasan percobaan login tidak dibagi antar proses dan tidak bertahan saat restart

- Severity: Medium, hardening autentikasi; bukan bypass akun yang terkonfirmasi.
- Status: RESOLVED & VERIFIED.
- Bukti: `src/auth.js:28-37` membuat Map lokal untuk kegagalan per kombinasi IP/email dan per IP. Batasnya diperiksa di `src/auth.js:64-79`. Secara terpisah, rate limiter IP untuk webhook Tebar menyimpan bucket dalam Map proses di `src/rate-limit.js:3-25`.
- Reproduksi aman berbasis desain: batas lokal hanya diketahui instance yang menerima request. Request yang tersebar ke instance lain atau proses yang baru dimulai tidak melihat penghitung instance sebelumnya. Tidak dilakukan percobaan password terhadap akun.
- Dampak: Distributed guessing atau restart/scale-out dapat mengurangi efektivitas rate limit. Verifikasi password scrypt tetap membebani tebakan, tetapi bukan pengganti counter bersama.
- Rekomendasi awal: Untuk deployment multi-instance, pindahkan penghitung autentikasi ke penyimpanan bersama dengan operasi atomik, gunakan batas per akun dan per IP, backoff bertahap, dan pertahankan proteksi edge. Hindari lockout permanen yang dapat dipakai untuk denial of service.
- Uji setelah perbaikan: Uji batas di dua instance terhadap akun dan IP yang sama, expiry jendela, reset counter setelah login valid, serta respons 429 tanpa membocorkan keberadaan akun.
- Remediasi: `migrations/009_login_attempts.sql` menambah tabel shared counter berindeks expiry. `src/repository.js` mereservasi batas pair/email+IP, account, dan IP dalam transaksi dengan row lock. Default batas adalah 8, 20, dan 40 percobaan per 15 menit. Login valid melepas reservasinya; kegagalan kredensial tetap dihitung. Email overlong tidak dipotong dan tidak dapat resolve ke akun yang prefix-nya valid; seluruh nilai dipakai untuk hash identitas throttle. `src/auth.js` meneruskan retry delay dari repository dan `src/server.js` membatasi header `Retry-After` ke nilai positif yang valid.
- Keputusan desain: fixed window tetap digunakan tanpa eskalasi backoff progresif. Batas percobaan yang jelas dan jangka 15 menit mudah diprediksi, sedangkan lockout progresif memperbesar risiko denial-of-service melalui penguncian akun yang disengaja. Durasi tunggu aktual dikirim kepada admin.
- Bukti: `test/auth.test.js`, `test/repository.test.js`, `test/server.test.js`, dan `test/database.integration.test.js`; pengujian MySQL lokal memverifikasi shared storage dan percobaan konkurens lintas dua repository.

### SEC-02 — URL CTA tidak dibatasi ke hostname resmi

- Severity: Low.
- Status: RESOLVED & VERIFIED; tidak ada SSRF terkonfirmasi.
- Bukti: `src/policy.js:100-106` memeriksa URL HTTPS, kredensial URL, dan panjang, tetapi tidak memeriksa hostname. Validasi template brand di `src/http/routes/templates.js:45-52` menerima HTTP atau HTTPS dan juga tidak membatasi hostname.
- Dampak: Admin yang salah konfigurasi atau akun admin yang diambil alih dapat menyimpan CTA ke situs yang tidak terkait. Source yang ditinjau tidak menunjukkan server melakukan fetch URL tersebut; karena itu ini bukan bukti SSRF.
- Rekomendasi: Izinkan hanya domain homepage/CTA Kedai Merzz dan subdomain yang disetujui, dengan aturan konsisten pada template dan pengaturan. Tampilkan domain tujuan dengan jelas di dashboard.
- Uji setelah perbaikan: Tolak domain luar, domain dengan userinfo, skema non-HTTP(S), hostname mirip, dan subdomain palsu; terima hanya domain resmi sesuai aturan.
- Remediasi: validator bersama `isApprovedCtaUrl` pada `src/policy.js` menerima HTTPS untuk `kedaimerzz.com` dan subdomainnya saja, tanpa userinfo atau port eksplisit; pengaturan dan template memakai validator yang sama.
- Bukti: `test/policy.test.js`, `test/server.test.js`, dan `test/content-service.test.js` menguji domain luar, hostname mirip, dan subdomain resmi.

### SEC-03 — Endpoint readiness publik menyertakan status scheduler

- Severity: Low.
- Status: RESOLVED & VERIFIED.
- Bukti: `src/server.js:39-49` menyediakan `/health/ready` tanpa autentikasi. Jika `services.schedulerStatus` tersedia, isi status scheduler disertakan pada response di baris 45-46.
- Dampak: Metadata operasional dapat membantu pihak luar menyimpulkan keadaan internal service. Pemeriksaan yang ada tidak menunjukkan token, konten posting, atau credential di payload status saat ini.
- Rekomendasi: Jadikan readiness publik minimal (`ready/not_ready`) dan batasi detail scheduler ke dashboard admin atau monitoring jaringan privat.
- Uji setelah perbaikan: Pastikan endpoint publik tidak mengandung detail internal; verifikasi monitoring privat masih dapat memperoleh diagnosa yang diperlukan.
- Remediasi: `/health/ready` di `src/server.js` hanya memberi `{status:"ready"}` atau `{status:"not_ready"}`; detail scheduler tidak lagi dimasukkan ke respons publik.
- Bukti: `test/server.test.js` memverifikasi response sukses dan gagal tetap minimal walau detail scheduler internal tersedia.

## Kontrol yang diperiksa dan tidak menunjukkan temuan

### Validasi input

- Route fakta membatasi service ke `topup/account`, menerima boolean `active`, membatasi ukuran JSON ringkasan, allowlist field per layanan, whitelist game top-up, dan membatasi panjang atribut di `src/http/routes/dashboard.js:86-114`.
- Pengaturan melakukan validasi enum, timezone IANA, mode harga/stok, hashtag, URL, panjang field, serta koleksi guardrail di `src/policy.js:90-124`.
- Template memeriksa kategori, panjang string/list, dan keanggotaan whitelist game di `src/http/routes/templates.js:33-70`.
- JSON parser menggunakan batas 256 KB dan strict mode di `src/server.js:34-36`.
- Batas string dan schema ini mengurangi risiko payload abnormal. Belum ada pengujian dinamis oversized/malformed yang diverifikasi dalam audit.

### SQL injection dan database

- Repository menggunakan `execute(sql, values)`/placeholder untuk nilai dinamis; contoh audit log di `src/repository.js:29` dan banyak operasi database lainnya.
- Identifier query dinamis pada jalur pembaruan dibentuk dari daftar kolom yang diizinkan menurut inspeksi source, bukan nama field mentah dari request.
- Tidak ditemukan query string yang menggabungkan nilai input mentah pada jalur aplikasi yang diperiksa.
- Hak akses database yang benar-benar dipakai pada VPS belum dapat dipastikan dari source; prinsip least privilege perlu diverifikasi saat deployment.

### XSS dan browser

- Data post, aktivitas, dan admin dirender sebagai teks melalui `textContent`; contoh `public/app.js:275-296,305-323`.
- Penggunaan `innerHTML` yang ditemukan hanya menyisipkan dua SVG literal statis untuk ikon mata password di `public/app.js:57-64`; tidak ada nilai pengguna yang masuk ke string tersebut.
- Server memasang Content Security Policy dan header keamanan di `src/server.js:22-32`.
- URL CTA divalidasi pada backend; allowlist hostname tetap direkomendasikan sebagai hardening terpisah.

### CSRF, sesi, dan kontrol akses

- Cookie sesi menggunakan `HttpOnly`, `SameSite=Strict`, dan `Secure` di production di `src/http/middleware.js:18-19`.
- Mutasi memeriksa Origin dan token CSRF dengan `timingSafeEqual` di `src/http/middleware.js:20-49`.
- Mutasi dashboard/admin dan logout yang diperiksa menggunakan middleware autentikasi serta CSRF/Origin. Login tidak memiliki sesi; route-nya memeriksa Origin di `src/http/routes/session-admin.js:13-21` dan menggunakan throttle autentikasi. Webhook tidak memakai sesi; route-nya memverifikasi signature Tebar.
- Password disimpan sebagai scrypt hash; token sesi disimpan dengan hash menurut implementasi `src/auth.js`.
- Validasi deployment masih perlu memastikan TLS, base URL, konfigurasi reverse proxy, dan asal request cocok dengan nilai production.

### Webhook, SSRF, command injection, dan deserialisasi

- Webhook memvalidasi signature dan timestamp atas raw body serta memiliki batas ukuran dan deduplikasi event menurut `src/webhook.js`, route di `src/server.js:34-36`, dan repository.
- Provider menggunakan endpoint dasar yang ditentukan aplikasi; tidak ditemukan fetch ke URL bebas dari input pengguna. Karena itu tidak ada SSRF terkonfirmasi.
- Tidak ditemukan penggunaan `child_process`, eksekusi shell, upload file, atau deserialisasi objek berbahaya pada source yang ditinjau.
- Webhook invalid signature, replay, payload malformed, dan request duplikat belum diuji secara dinamis dalam audit ini.

## Status pengujian dan keterbatasan

Audit awal bersifat statis. Remediasi berikutnya diuji pada aplikasi dan MySQL yang terisolasi di Docker lokal. Tidak ada payload uji yang dikirim ke Threads, Tebar, Telegram, atau layanan eksternal. Tidak ada live post maupun data production yang diubah.

Verifikasi final pada 9 November 2026 menggunakan project Docker Compose test terisolasi `merzz-final-20261109` dan MySQL baru. Runtime smoke test memakai project sementara `merzz-final-20261108`:

- `npm run check`: lulus.
- `npm test`: 217 lulus, 0 gagal, 0 dilewati.
- `npm run test:integration`: 63 lulus, 0 gagal, 0 dilewati; termasuk migrasi dan rate limit shared MySQL.
- `npm audit`: 0 vulnerability.
- Runtime image `kedai-merzz-threads:remediation-final` berhasil dibangun. Container lokal melaporkan readiness 200, dashboard 200, API terlindungi 401 tanpa sesi, login test 200, session authenticated, dan dashboard terlindungi 200. Delapan login gagal terkendali diikuti 429 dengan `Retry-After: 900`.

Database dan kredensial yang dipakai hanya data disposable di Docker lokal. Pengujian tidak menyentuh Threads, Tebar, Telegram, atau environment production.

Hal berikut masih memerlukan validasi sebelum production:

- Verifikasi `trust proxy` dan proteksi rate limit edge pada konfigurasi VPS; IP sumber perlu dipastikan oleh reverse proxy tepercaya.
- TLS, reverse proxy, Origin/base URL, dan akses jaringan database.
- Konfigurasi hak minimum user MySQL dan pengelolaan secret di server.
- Pengujian session invalidation, CSRF, signature/replay webhook, SQLi/XSS payload, dan duplicate request khusus pada staging terisolasi masih diperlukan sebelum production.
- Pengujian browser nyata, screen reader, dan kondisi mobile.
- Validasi akun Threads testing serta workspace Tebar staging; tidak ada layanan eksternal yang diuji.
- Ketahanan semantic content review terhadap prompt injection; data panduan admin memang dikirim ke AI sebagai konteks dan validasi berbasis model bukan jaminan keamanan formal.

## Kesimpulan kesiapan

Tidak ada temuan Critical/High yang terkonfirmasi; ketiga temuan audit sudah RESOLVED & VERIFIED. Aplikasi siap untuk verifikasi staging terisolasi, tetapi belum dinyatakan production-ready. Sebelum production, verifikasi TLS/reverse proxy, IP tepercaya, least privilege MySQL, siklus webhook, dan integrasi akun Tebar/Threads staging.
