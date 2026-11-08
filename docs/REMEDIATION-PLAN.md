# Rencana Remediasi Audit UI/UX dan Keamanan Input

Tanggal audit awal: 8 November 2026

Tanggal implementasi dan verifikasi: 9 November 2026
Dasar: temuan pada `docs/UI-UX-AUDIT.md` dan `docs/INPUT-SECURITY-AUDIT.md`.

## Prioritas

Status setelah implementasi: seluruh temuan UX-01 sampai UX-07 dan SEC-01 sampai SEC-03 telah diimplementasikan. Perubahan lokal menargetkan test dan verifikasi staging; tidak ada deployment production atau posting langsung.

| Prioritas | Temuan | Tujuan | Dampak / kompleksitas | Risiko regresi |
|---|---|---|---|---|
| P0 | Tidak ada temuan Critical terkonfirmasi | Tidak ada remediasi P0 saat ini | — | — |
| P1 | SEC-01 rate limit autentikasi tersimpan di memori | Counter MySQL bersama atomik, batas pair/account/IP, response Retry-After | **RESOLVED & VERIFIED**; migration `009_login_attempts.sql` | Sedang: perilaku 429 diuji unit dan MySQL integration |
| P1 | UX-01 pesan validasi tidak jelas | Pesan Indonesia dan field-level feedback yang mempertahankan detail API | **RESOLVED & VERIFIED**; `test/ui-remediation.test.js` | Rendah: kode tidak dikenal tetap menjadi error umum |
| P1 | UX-02 submit berulang | Pending state untuk form, kunci nilai selama request dan pulih di finally | **RESOLVED & VERIFIED**; `test/ui-remediation.test.js` | Rendah: jalur sukses/gagal diuji |
| P1 | Validasi deployment dan webhook belum dibuktikan | Jalankan pengujian terisolasi pada staging: TLS/Origin, CSRF, signature/replay, duplicate event, serta rate limit | Sedang; bergantung pada staging | Rendah bila memakai workspace/akun testing |
| P2 | SEC-02 hostname CTA | Batasi domain tujuan resmi pada policy dan template | **RESOLVED & VERIFIED**; subdomain `kedaimerzz.com` diizinkan | Sedang: CTA lama di luar allowlist ditolak |
| P2 | SEC-03 readiness terlalu informatif | Minimalisasi response readiness publik | **RESOLVED & VERIFIED**; test sukses/gagal | Rendah: diagnosis privat tetap di monitoring internal |
| P2 | UX-03 navigasi tab mobile | Bungkus tab dan sediakan navigasi keyboard | **RESOLVED & VERIFIED** lewat test CSS/DOM; viewport nyata masih perlu QA | Rendah |
| P2 | UX-04 onboarding tidak menunjuk pengaturan yang hilang | Tautkan checklist ke tab/field | **RESOLVED & VERIFIED**; mapping/fokus diuji | Rendah |
| P2 | UX-05 fokus setelah login/logout | Fokuskan tampilan yang baru terlihat | **RESOLVED & VERIFIED**; logic diuji, login browser diperiksa | Rendah; logout keyboard belum manual diuji |
| P2 | UX-06 state tab tidak semantik | ARIA lengkap dan keyboard tab | **RESOLVED & VERIFIED** lewat test DOM/keyboard; screen reader belum diuji | Sedang |
| P3 | UX-07 metadata tema tidak konsisten | Selaraskan skema warna HTML/CSS | **RESOLVED & VERIFIED** lewat test dan pemeriksaan desktop | Rendah; matriks lintas browser belum diuji |
| P3 | Verifikasi kontras dan WCAG AA belum dilakukan | Ukur seluruh kombinasi teks/status/focus dan perbaiki yang gagal | Rendah-sedang | Rendah |

## Implementasi dan verifikasi

1. Migration `009_login_attempts.sql` dan repository menerapkan throttling login atomik berbagi MySQL. Fixed window 15 menit dipertahankan agar batas retry jelas; eskalasi progresif tidak dipakai karena memperbesar risiko account lockout/DoS. `Retry-After` dihitung dari jendela terlama yang masih menghalangi percobaan.
2. Frontend menerapkan validasi spesifik, state pending untuk mencegah pengiriman ganda, tab mobile yang membungkus, navigasi onboarding, fokus login/dashboard, ARIA, dan tema native gelap.
3. Validator CTA bersama membatasi ke `https://kedaimerzz.com` dan subdomainnya pada settings dan template. Readiness publik hanya mengembalikan status minimal.
4. Regresi unit, integration dengan MySQL Docker, browser smoke lokal, dan `npm audit` dijalankan. Tidak ada panggilan provider nyata.

## Kriteria selesai perbaikan

- Selesai dan diuji: pencegahan submit ganda, feedback error form, throttle MySQL lintas repository, validasi CTA, readiness minimal, navigasi onboarding, fokus login/dashboard, ARIA/keyboard tab, serta metadata tema.
- Masih memerlukan QA manual: keyboard penuh untuk semua form/logout, viewport mobile 320/375/430 px, screen reader, matriks browser, zoom/orientasi, dan pengukuran kontras WCAG 2.2 AA.
- Regresi unit dan integration Docker lokal tercatat di `docs/INPUT-SECURITY-AUDIT.md`; akun provider staging dan pengaturan deployment VPS belum diuji.

## Dampak dan batas scope

Remediasi rate limit menambah tabel MySQL secara additive. Deploy perlu menjalankan migrasi sebelum endpoint login baru digunakan; aplikasi fail-closed bila storage throttle tidak tersedia. Fixed window dapat menyebabkan jeda login hingga 15 menit saat batas tercapai. Pembatasan hostname menolak URL CTA lama di luar `kedaimerzz.com`. Visual QA viewport mobile, screen reader, kontras WCAG, dan pengujian provider staging masih terbuka.

Status kesiapan: remediation source dan test siap untuk verifikasi staging terisolasi. Production belum dideploy dan tidak ada akun atau credential production yang digunakan.
