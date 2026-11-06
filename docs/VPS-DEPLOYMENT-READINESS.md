# Laporan Kesiapan Deployment VPS BotMerzz

**Tanggal audit:** 6 November 2026
**Cakupan:** codebase, Docker Compose, MySQL, AI guardrails, Tebar, scheduler, Telegram, CI/CD, dan pengujian lokal. Tidak ada koneksi SSH/VPS, permintaan API provider, atau publikasi Threads sungguhan.

## 1. Ringkasan eksekutif

**Status: READY WITH BLOCKERS.** Codebase dan konfigurasi layak dipasang pada VPS staging dengan scheduler dan automation tetap nonaktif. Docker lokal membuktikan runtime berjalan, health check sukses, migrations diterapkan, dan volume MySQL bertahan setelah seluruh service dihentikan lalu dibuat kembali.

Sebelum pengujian publikasi live, masih diperlukan kredensial staging Tebar/OpenRouter/Telegram, konfirmasi Profile ID dan Account ID Threads testing, ingress HTTPS, akses pull GHCR, serta persetujuan eksplisit untuk membuat satu post berlabel `TEST` dan mengaktifkan scheduler. Status provider dan keberadaan post pada Threads belum diverifikasi secara live.

## 2. Status komponen

| Area | Status | Bukti dan batasan |
|---|---|---|
| Node.js, API, dashboard | Siap untuk staging | Node 22 runtime; admin API memakai session, CSRF, same-origin validation, cookie Secure di production. HTTP tests berjalan dalam Docker. |
| AI dan guardrails | Mock teruji | Prompt Melayu Malaysia, fakta terstruktur, dan validasi klaim tersedia. Belum dijalankan dengan OpenRouter key atau knowledge Kedai Merzz staging. |
| MySQL dan migrations | Teruji lokal | MySQL 8.4, empat migrations, advisory lock, readiness `200`, dan volume persisten setelah restart Compose. |
| Docker runtime | Teruji lokal | Build default adalah runtime; container memakai user `node`; port app terikat ke loopback; database tidak punya host port. |
| Scheduler | Siap dengan opt-in | Poller in-process 60 detik default. `SCHEDULER_ENABLED=false` secara default; belum ada scheduler live. |
| Tebar | Mock dan kontrak terdokumentasi | Adapter mock menguji Bearer key, profile header, payload, idempotency key, error, dan status. Tidak ada API call atau akun testing yang diverifikasi. |
| Telegram | Mock dan outbox teruji | Outbox durable, deduplikasi, retry, success/failure, AI failure, account disconnect, dan daily summary tersedia. Pengiriman ke chat nyata belum diuji. |
| GitHub Actions/GHCR | Konfigurasi siap | CI memuat audit dependency, checks, tests, dan runtime build. Publish memakai SHA tag dan mencatat digest. Workflow GitHub/pull GHCR belum dijalankan. |

## 3. Temuan audit dan severity

### Ditangani

- **P1 — Dockerfile membangun stage test sebagai default.** Stage `test` sebelumnya berada terakhir, sehingga image runtime berisiko menjalankan `npm test`. Stage `runtime` kini menjadi default; CI dan publish workflow juga secara eksplisit memilih `runtime`.
- **P1 — Compose tidak menjalankan dispatcher otomatis.** Server sebelumnya hanya melayani dashboard. Poller opsional kini berjalan dalam proses Node.js, memeriksa saat start lalu polling tiap 60 detik. Default scheduler tetap nonaktif.
- **P1 — Outcome publish tak pasti dapat memicu replay.** Dispatcher tidak lagi mengirim ulang request tanpa provider post ID. Slot yang belum dapat direkonsiliasi menahan publikasi berikutnya sampai operator menyelesaikan statusnya.
- **P2 — Notifikasi publish sukses Telegram tidak tersedia.** Success notice kini berasal dari dispatcher atau webhook Tebar; keduanya memakai dedupe key berbasis slot.
- **P2 — Login limit dapat dilewati dengan mengganti email.** Ditambahkan batas per-IP di samping batas per IP/email. Limit aplikasi in-memory; reverse proxy perlu menerapkan limit lintas restart/replica.
- **P2 — Webhook belum memiliki request limit.** Sekarang dibatasi 120 request/menit per IP sebelum body parsing. Limit di reverse proxy tetap diperlukan.
- **P2 — Port host yang diubah dapat membuat origin login tidak cocok.** Default `BASE_URL` lokal kini mengikuti `HOST_PORT`, kecuali diatur eksplisit.

### Masih terbuka

- **P2 — Live provider/account acceptance belum dilakukan.** Kredensial/workspace Tebar testing tidak tersedia. Belum ada post ID, status provider aktual, permalink, atau bukti post tampil pada Threads testing.
- **P2 — VPS dan ingress belum ditentukan.** OS, domain, HTTPS reverse proxy, firewall/access policy, backup destination, dan monitoring belum diberikan.
- **P2 — Nilai password pada perubahan lokal `.env.example` lemah dan digunakan ulang.** Perubahan tersebut sudah ada sebelum audit dan tidak disentuh. Jangan gunakan nilainya di VPS.
- **P3 — Rate limit aplikasi bersifat per-proses.** State dapat reset saat restart atau terpisah di replica; wajib ada limit ingress.
- **P3 — GitHub/GHCR belum diverifikasi live.** Workflow mencatat image digest untuk deployment pin-by-digest, tetapi tidak dijalankan dari GitHub dalam audit ini.

## 4. Perbaikan yang dilakukan

- Menambahkan scheduler poller yang mencegah overlap, melaporkan status aman, dan menunggu job aktif saat shutdown.
- Menambahkan `SCHEDULER_ENABLED` (default `false`), `SCHEDULER_INTERVAL_SECONDS` (default 60; rentang 15–3600), dan `TRUST_PROXY` (default `false`).
- Menambahkan per-IP login limit dan webhook limit.
- Mengubah penanganan outcome tak pasti agar tidak replay tanpa ID; slot unresolved menahan slot baru.
- Menambahkan Telegram success notification dari dispatcher maupun webhook dengan deduplikasi.
- Mengizinkan literal `TEST` dalam kosakata hook agar caption uji jelas dapat lolos guardrail tanpa mengubah interval bisnis.
- Menambahkan `compose.vps.yaml`: image GHCR wajib, production mode, non-root, filesystem read-only, network DB internal, port loopback, health check, restart policy, dan volume persisten.
- Mengunci CI/publish ke runtime target dan mencatat digest ke GitHub workflow summary.
- Memperbarui dokumentasi deployment, scheduler, operasi, dan test plan.

## 5. Hasil Docker dan testing

- `docker build --tag botmerzz-readiness:runtime .` — berhasil; image default memakai user `node` dan command `npm start`.
- `docker compose ... up --build -d --wait` — berhasil pada project lokal terisolasi. `/health/ready` mengembalikan HTTP 200 dengan scheduler nonaktif.
- Runtime container berjalan sebagai UID/GID `1000(node)`. MySQL tidak dipublikasikan (`PortBindings {}`); port app hanya `127.0.0.1`.
- `docker compose down` lalu `up --wait` tanpa `-v` — berhasil; empat versi migration tetap ada setelah restart.
- Compose lokal dan `compose.vps.yaml` lolos `docker compose config --quiet` menggunakan nilai sintetis.
- Docker test profile: `npm run check` lulus, `npm test` **110/110 lulus**, `npm run test:integration` **35/35 lulus**. Integration tests mencakup dua klaim MySQL konkuren dengan satu pemenang dan pemulihan payload/idempotency key setelah koneksi pool baru.
- Host full suite sempat gagal pada empat tes HTTP karena sandbox menolak `listen(127.0.0.1)` (`EPERM`). Suite yang sama berjalan di Docker dan seluruh tests lulus.
- Pengujian memakai environment file sementara dan kredensial sintetis. Tidak ada `.env` dibaca. Container dan database test terisolasi dibersihkan.

## 6. Integrasi Tebar

Konfigurasi membaca `TEBAR_API_KEY`, `TEBAR_PROFILE_ID`, `TEBAR_ACCOUNT_ID`, dan `TEBAR_WEBHOOK_SECRET`. Adapter memakai Bearer auth, `Tebar-Profile`, target `account_id`, `Idempotency-Key`, status per-target, dan GET status post.

Kontrak diperiksa pada [dokumentasi resmi create/status post Tebar](https://docs.tebar.app/en/api/posts/) dan [dokumentasi webhook Tebar](https://docs.tebar.app/en/api/webhook/). Tebar mendokumentasikan publish asinkron dengan status target/permalink, serta HMAC-SHA256 atas timestamp dan raw body dengan freshness window lima menit.

**Belum terbukti:** API auth live, kesesuaian Profile ID/Account ID staging, status publikasi provider, permalink, dan keberadaan post pada akun Threads yang benar. Kredensial/ID tidak tersedia untuk diverifikasi dan tidak dibuat-buat.

## 7. Scheduler dan cron

- Memakai poller JavaScript dalam proses Node, bukan `node-cron` atau system cron. Hanya aktif jika `SCHEDULER_ENABLED=true`.
- Timezone default `Asia/Kuala_Lumpur`; schedule memakai IANA timezone dan default active window 09:00–22:00. Validasi menolak interval di bawah enam jam.
- Slot, klaim, payload, dan idempotency key tersimpan di MySQL. Unique scheduled instant, transaksi/row lock, dan klaim atomik melindungi run konkuren.
- Slot lebih dari 15 menit terlambat atau di luar active window dilewati tanpa catch-up. Payload yang sudah dipersiapkan dapat dipulihkan setelah restart.
- Emergency pause menghentikan klaim baru. Outcome tak pasti tanpa provider ID tidak direplay dan menahan slot berikutnya.
- `/health/ready` menampilkan status poller dan hasil/error code aman.
- **Belum diuji live:** ketepatan scheduled-to-published di VPS. Setelah approval, siapkan satu slot `pending` terisolasi di DB staging pada active window; scheduler production yang sama mengambilnya. Jangan ubah cadence enam jam dan jangan lakukan pada production.

## 8. Telegram notifications

Kode menyediakan notice publish success/failure, generation failure, webhook account expired/disconnected, dan daily summary pada 22:00 timezone schedule. Outbox MySQL menyimpan notice sebelum pengiriman dan menangani deduplikasi, backoff, batas retry, serta klaim aman saat restart.

Coverage adapter/webhook/outbox berbasis mock dan MySQL lokal lulus. `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` belum tersedia; delivery live belum diuji.

## 9. CI/CD GitHub Actions

`ci.yml` menjalankan `npm ci`, `npm audit --audit-level=high`, syntax checks, unit/integration tests dengan MySQL, dan runtime Docker build. `publish.yml` berjalan setelah CI sukses pada push `main`, menerbitkan full commit-SHA tag dan tag bergerak `main`, serta mencatat digest. `compose.vps.yaml` tidak membangun source lokal dan menarik image dari `APP_IMAGE`.

Tidak ada deployment workflow VPS. Akses GHCR, image/digest yang benar-benar tersedia, workflow GitHub, dan rollback release belum diverifikasi lewat GitHub.

## 10. Keamanan dan risiko operasional

- Image tidak menyalin `.env`; Dockerfile menyalin package, source, public assets, dan migrations. `.dockerignore` mengecualikan environment files. Secrets diberikan saat container runtime.
- Dashboard API memakai autentikasi, session token hash, CSRF, same-origin, cookie HTTP-only/Secure/SameSite, dan HTTPS `BASE_URL` di production. Port app loopback; HTTPS proxy/access controls perlu disediakan.
- Webhook memverifikasi raw-body HMAC, timestamp, body limit 256 KiB, event dedupe, profile/account scope, dan limit aplikasi. Terapkan ingress rate limit dan sinkronkan jam server.
- DB tidak memiliki host port pada konfigurasi VPS; app non-root. File environment VPS perlu mode `0600`. Admin host Docker tetap dapat membaca environment container.
- Volume bukan backup. Tetapkan backup terenkripsi dan uji restore sebelum publikasi.
- Login/webhook limit in-memory bukan pengganti limit reverse proxy lintas replica/restart. Belum ada monitoring/alert eksternal atau rotasi credentials terotomasi.

## 11. Informasi dan konfigurasi VPS yang masih dibutuhkan

### Detail host staging yang diberikan setelah audit

- Operator melaporkan host menggunakan Ubuntu Server 24.04.5 LTS (`noble`), `x86_64`/amd64. Versi OS dan arsitektur ini didukung Docker Engine resmi ([dukungan platform Docker](https://docs.docker.com/engine/install/ubuntu/)). Saat pemeriksaan awal Docker Engine dan Compose belum terpasang; kemudian operator memasangnya. Host belum saya inspeksi langsung melalui SSH.
- Pemeriksaan lanjutan yang dijalankan operator melaporkan Docker Engine 29.9.3 aktif dan enabled saat boot, Compose 5.7.0, serta `hello-world` berhasil. `ss -lntp` hanya memperlihatkan SSH pada TCP 22. UFW kini aktif dengan inbound default `deny`, outbound `allow`, routed `deny`, dan hanya SSH `22/tcp` terbuka untuk IPv4/IPv6. Operator belum melaporkan uji login SSH kedua; firewall provider belum dikonfirmasi.
- Disk root 25 GB, sekitar 20 GB tersedia: cukup untuk memulai staging kecil, tetapi image lama, pertumbuhan MySQL, dan log dapat menghabiskan ruang. Simpan backup di luar disk host.
- RAM sekitar 1.9 GiB dengan swap 1 GiB. Batas app di Compose adalah 512 MiB, sedangkan MySQL tidak diberi hard memory cap. Instalasi bisa dimulai, tetapi headroom untuk app, MySQL, dan OS ketat; pantau memory/OOM dan pertimbangkan naik ke 4 GiB sebelum scheduler atau publikasi live diaktifkan.

- Nama project staging, domain, HTTPS proxy/access policy, firewall, backup destination, host port, dan versi Docker Engine/Compose setelah instalasi.
- GHCR package visibility/read credential; set `APP_IMAGE` ke digest dari workflow summary.
- Environment file staging terpisah dengan `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_ROOT_PASSWORD`, dan HTTPS `BASE_URL`.
- Workspace Tebar staging; konfirmasi `TEBAR_PROFILE_ID`, `TEBAR_ACCOUNT_ID`, username/platform Threads, API key, dan webhook secret bila webhook dipakai.
- OpenRouter API key/model, Telegram token/chat ID, brand voice, whitelist, tracked links, fakta produk segar, approved/forbidden claims, active days/hours.
- Kebijakan backup/restore, retensi logs, monitoring, penanggung jawab live test, dan rollback procedure.

Staging dan production perlu Compose project, environment file, database, volume, credentials, dan provider workspace yang terpisah. Biarkan `SCHEDULER_ENABLED=false` pada startup awal.

## 12. Rencana end-to-end live testing (setelah approval)

1. **A — AI content:** gunakan knowledge Kedai Merzz staging; inspeksi bahasa Melayu Malaysia, approved facts/links, dan label `TEST`. Tolak konten dengan harga, stok, diskon, klaim, atau atribut yang tidak disetujui; admin review sebelum publish.
2. **B — Tebar:** lakukan GET read-only untuk workspace dan akun. Setelah approval live, kirim satu post `TEST` ke Account ID Threads testing. Catat post ID, status target, permalink, dan `published_at`; buka permalink dan pastikan post muncul pada akun yang benar.
3. **C — Scheduler:** di database staging saja, siapkan satu slot one-time `pending` di active window. Aktifkan poller 60 detik tanpa mengubah minimum enam jam. Catat `scheduled_at`, `published_at`, selisih waktu, status slot, dan activity log.
4. **D — Failure/recovery:** gunakan mocks untuk AI failure, timeout, Tebar error, invalid account, restart dengan volume, duplicate invocation, pause, dan unknown outcome. Pastikan timeout tanpa ID tidak direplay dan menahan slot baru.
5. **E — Telegram:** verifikasi success/failure, generation failure, account disconnect, dan summary pada chat staging. Jangan gunakan group production.
6. Simpan hasil provider dan Threads; pause automation setelah test dan putuskan apakah staging tetap aktif. Production memerlukan review/approval terpisah.

## 13. Go/no-go staging

### GO untuk memasang dashboard staging dengan publikasi nonaktif

- [x] Runtime Docker build dan Compose readiness berhasil secara lokal.
- [x] MySQL health, migrations, volume persisten, restart, non-root, loopback app port, dan DB tanpa port publik terverifikasi lokal.
- [x] CI/test workflow memuat checks, tests, dependency audit, dan GHCR runtime build.
- [x] Scheduler dan automation default nonaktif; VPS Compose mewajibkan GHCR image serta HTTPS origin.

### NO-GO untuk mengaktifkan scheduler/publikasi live sampai semua terpenuhi

- [ ] VPS, ingress HTTPS, firewall/access policy, backup, dan monitoring disediakan serta diuji.
- [ ] GHCR image di-pull dengan digest dan commit yang disepakati.
- [ ] Kredensial Tebar/OpenRouter/Telegram staging disimpan aman di environment VPS.
- [ ] Profile ID, Account ID, username/platform Threads, dan workspace testing dikonfirmasi pemilik akun.
- [ ] Brand knowledge/fakta/guardrails disetujui; caption berlabel `TEST` diperiksa manusia.
- [ ] Ada approval eksplisit untuk `SCHEDULER_ENABLED=true`, automation aktif, dan satu post sungguhan ke akun Threads testing.
- [ ] Provider status/permalink, keberadaan post di Threads, jadwal aktual, webhook, dan Telegram dicatat.

**Rekomendasi:** pasang dashboard VPS staging hanya dengan publishing nonaktif. BotMerzz belum layak untuk uji publikasi end-to-end melalui Tebar sampai item NO-GO selesai dan live test disetujui.
