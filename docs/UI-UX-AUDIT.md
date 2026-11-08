# Audit UI/UX BotMerzz

Tanggal audit awal: 8 November 2026

Tanggal verifikasi remediasi: 9 November 2026

Revisi yang diperiksa: branch `codex/creative-content-variation`, commit `bb4f580`
Metode: inspeksi statis HTML, CSS, JavaScript frontend, dan endpoint validasi backend. Tidak ada source yang diubah.

## Ringkasan eksekutif

Dashboard menyediakan alur utama untuk panduan konten, template, jadwal, informasi produk, riwayat, dan pengelolaan admin. Layout memiliki breakpoint mobile, tombol utama minimal 44 px, label form semantik, pesan sukses/error berbasis live region, dan state kosong pada daftar. Palet gelap biru-kuning yang diminta juga diterapkan melalui override CSS.

Semua temuan UX-01 sampai UX-07 telah diperbaiki dan lulus verifikasi terarah. Verifikasi mencakup test UI, runtime dashboard lokal, login dan validasi field di browser, serta tinjauan screenshot desktop. Tidak ada klaim kesesuaian WCAG: viewport mobile nyata, teknologi bantu, dan matriks browser belum diuji.

## Temuan

### UX-01 — Pesan validasi API tidak spesifik dan dapat menampilkan kode internal

- Severity: Medium
- Status: RESOLVED & VERIFIED.
- Keyakinan: Tinggi
- Bukti: `public/app.js:18-28` menerjemahkan sejumlah kode error, tetapi fallback `errorText` menampilkan `error.message` langsung. Form produk di `public/app.js:405-430` menampilkan kegagalan lewat banner global. Backend mengembalikan error terstruktur seperti `INVALID_FACT_PRICE`, `INVALID_FACT_FIELDS`, dan `GAME_NOT_WHITELISTED` di `src/http/routes/dashboard.js:86-114`.
- Dampak: Admin dapat melihat kode teknis atau tidak tahu field mana yang perlu diperbaiki. Ini menambah waktu onboarding dan risiko salah konfigurasi.
- Rekomendasi: Petakan semua error yang diketahui ke pesan Bahasa Indonesia. Untuk error dengan `fields`, kaitkan pesan ke field terkait, tambahkan `aria-invalid` dan `aria-describedby`, lalu fokuskan field pertama yang gagal. Pertahankan banner global untuk error sistem.
- Uji setelah perbaikan: Simulasikan setiap error API form; pastikan pesan Indonesia, field terkait disorot/diumumkan screen reader, dan nilai input tetap terisi.
- Remediasi: `public/app.js` mempertahankan detail `fields` dari API, menerjemahkan error form yang dikenal ke Bahasa Indonesia, menautkan pesan ke kontrol melalui `aria-describedby`, mengatur `aria-invalid`, dan memfokuskan field pertama setelah form kembali aktif.
- Bukti: `test/ui-remediation.test.js` lulus; runtime lokal menampilkan validasi field saat dashboard diuji di browser. Pengumuman screen reader belum diuji.

### UX-02 — Tombol simpan tidak menunjukkan proses dan tidak mencegah submit berulang

- Severity: Medium
- Status: RESOLVED & VERIFIED.
- Keyakinan: Tinggi
- Bukti: Handler login, admin, panduan brand, jadwal, fakta produk, serta template mengirim request asynchronous tanpa menonaktifkan tombol atau menandai form sebagai sedang diproses; contoh `public/app.js:346-430`. Tombol automation juga tidak mengunci tindakan selama request berjalan di `public/app.js:432-447`.
- Dampak: Klik berulang pada jaringan lambat dapat membuat permintaan ganda, aktivitas audit yang berulang, dan ketidakpastian apakah tindakan berhasil.
- Rekomendasi: Gunakan helper status submit yang mengunci tombol submit form selama request, menampilkan label proses yang jelas, menambahkan `aria-busy`, dan memulihkan state melalui `finally`. Untuk tindakan berisiko, cegah pengiriman ganda di server dengan idempotency bila sesuai.
- Uji setelah perbaikan: Tunda response API; klik berkali-kali dan pastikan hanya satu request dikirim, indikator terlihat, dan tombol pulih setelah sukses maupun gagal.
- Remediasi: helper `withPending` pada `public/app.js` mengunci semua kontrol form selama request, menampilkan label proses dan `aria-busy`, menolak submit ulang, lalu memulihkan state lewat `finally`. Payload kredensial dan form ditangkap sebelum kontrol dikunci.
- Bukti: test tertunda memeriksa submit tunggal, nilai yang tidak berubah selama request, dan pemulihan setelah sukses/gagal di `test/ui-remediation.test.js`.

### UX-03 — Navigasi tab di mobile dapat menyembunyikan tab yang tersedia

- Severity: Medium
- Status: RESOLVED & VERIFIED.
- Keyakinan: Tinggi
- Bukti: Dashboard memiliki enam tab di `public/index.html:58-64`. CSS membuat `.tabs` dapat digeser horizontal, tetapi menyembunyikan scrollbar dengan `scrollbar-width:none` dan `::-webkit-scrollbar{display:none}` di `public/styles.css:2`.
- Dampak: Pengguna dapat tidak menyadari bahwa Template, Riwayat, atau Admin berada di luar area yang terlihat, khususnya pada layar sempit.
- Rekomendasi: Pertahankan akses keyboard dan tambahkan petunjuk geser yang terlihat, indikator tepi, atau navigasi alternatif yang tetap ringkas pada mobile. Pastikan item aktif otomatis masuk area tampilan.
- Uji setelah perbaikan: Periksa lebar 320, 375, dan 430 px, navigasi keyboard, serta tab terakhir tanpa scrollbar horizontal halaman.
- Remediasi: `.tabs` membungkus tab agar semua tujuan tetap terlihat; scrollbar tersembunyi tidak lagi digunakan. Tab mendukung navigasi keyboard.
- Bukti: `test/ui-remediation.test.js` memeriksa wrapping, daftar semua tujuan, dan keyboard. Pemeriksaan visual khusus viewport 320/375/430 px belum dilakukan.

### UX-04 — Daftar onboarding tidak dapat langsung membuka pengaturan yang belum lengkap

- Severity: Low
- Status: RESOLVED & VERIFIED.
- Keyakinan: Tinggi
- Bukti: `renderOnboarding` membuat item teks biasa di `public/app.js:258-270`; markup hanya menyediakan `ul` di `public/index.html:53-55`.
- Dampak: Admin harus mencari sendiri tab dan field yang perlu dilengkapi.
- Rekomendasi: Jadikan item yang belum lengkap sebagai tautan/tombol menuju tab relevan, beri status selesai yang dapat dibaca, dan pertahankan urutan persiapan.
- Uji setelah perbaikan: Klik tiap item yang belum lengkap dan pastikan tab terkait aktif serta fokus berpindah ke judul atau field pertama.
- Remediasi: item onboarding yang belum selesai menjadi tindakan yang membuka tab terkait dan memfokuskan sasaran pengaturan/status.
- Bukti: pemetaan tujuan onboarding dan fokus diuji di `test/ui-remediation.test.js`.

### UX-05 — Perubahan tampilan login tidak memindahkan fokus

- Severity: Low
- Status: RESOLVED & VERIFIED.
- Keyakinan: Tinggi
- Bukti: `setAuthenticated` hanya mengubah properti `hidden` di `public/app.js:77-80`. Setelah login sukses dan logout di `public/app.js:346-357`, fokus tidak diarahkan ke judul atau kontrol utama pada tampilan baru.
- Dampak: Pengguna keyboard atau screen reader dapat kehilangan konteks setelah pergantian tampilan.
- Rekomendasi: Setelah login, fokuskan heading dashboard; setelah logout, fokuskan heading login atau field email. Hindari memindahkan fokus ketika response gagal.
- Uji setelah perbaikan: Jalankan alur login/logout hanya dengan keyboard dan periksa urutan serta pengumuman fokus.
- Remediasi: pergantian state login/dashboard memindahkan fokus ke target yang terlihat.
- Bukti: target fokus diperiksa dalam `test/ui-remediation.test.js`; login/dashboard lokal diuji di browser. Alur logout penuh hanya dengan keyboard belum diuji manual.

### UX-06 — Tab belum menyampaikan state semantik ke teknologi bantu

- Severity: Low
- Status: RESOLVED & VERIFIED.
- Keyakinan: Tinggi
- Bukti: Navigasi di `public/index.html:58-65` memakai tombol dan panel, tetapi tidak menetapkan `role=tablist/tab/tabpanel`, `aria-selected`, `aria-controls`, atau `aria-current`. `activateTab` dan handler tab hanya mengganti class di `public/app.js:252-256,450-455`.
- Dampak: Pembaca layar mungkin tidak mengetahui tab aktif atau hubungan tombol dengan panel; pola keyboard tab standar tidak mengikuti pola widget tab.
- Rekomendasi: Terapkan pola tab ARIA lengkap dengan roving tabindex dan tombol panah, atau gunakan navigasi tombol sederhana dengan state `aria-current` dan panel yang tetap dapat dipahami.
- Uji setelah perbaikan: Uji keyboard dan screen reader untuk semua tab, termasuk perubahan panel dan state aktif.
- Remediasi: markup menetapkan hubungan tab/panel, `aria-selected`, panel tersembunyi, roving focus, serta tombol panah/Home/End.
- Bukti: kontrak markup, state aktif, dan keyboard diuji di `test/ui-remediation.test.js`. VoiceOver/NVDA belum dijalankan.

### UX-07 — Metadata skema warna berbeda dengan tema yang dirender

- Severity: Low
- Status: RESOLVED & VERIFIED.
- Keyakinan: Tinggi
- Bukti: `public/index.html:6` menyatakan `color-scheme=light`, sementara `public/styles.css:5-7` mengatur `color-scheme:dark`, latar gelap, dan teks putih.
- Dampak: Kontrol native atau scrollbar dapat dirender berbeda bergantung browser dan prioritas style, sehingga kontras antarkomponen berpotensi tidak konsisten.
- Rekomendasi: Samakan metadata dokumen dan deklarasi CSS dengan tema aktif, lalu tinjau kembali kontrol select, checkbox, date, dan autofill di browser target.
- Uji setelah perbaikan: Uji Chrome, Safari, dan Firefox pada mode sistem terang dan gelap, khususnya select, checkbox, password field, dan scrollbar yang memang digunakan dashboard.
- Remediasi: metadata HTML dan tema native CSS diselaraskan ke skema gelap.
- Bukti: metadata dan CSS diperiksa oleh `test/ui-remediation.test.js`, lalu tampilan desktop diperiksa di browser lokal. Matriks lintas browser dan kontrol native belum diuji.

## Hal yang sudah baik

- Form memakai label yang membungkus kontrol dan tipe input yang sesuai untuk email/password; contoh `public/index.html:18-21`.
- Tombol dan kontrol utama umumnya memiliki tinggi minimum 44 px.
- Notice sukses/error memakai `role=status` dan `role=alert` di `public/index.html:42-43`.
- Konten dinamis riwayat, aktivitas, dan status admin umumnya dibuat dengan `textContent`, bukan HTML bebas; contoh `public/app.js:275-296,305-323`.
- CSS memiliki breakpoint mobile dan desktop (`public/styles.css:2,28-29`), focus-visible untuk tombol lihat kata sandi (`public/styles.css:3`), dan empty state untuk daftar.
- Dialog template menggunakan elemen HTML `dialog`; ukuran dan tinggi dialog dibatasi untuk viewport kecil di `public/styles.css:28`.

## Batas penilaian

Verifikasi remediasi menggunakan test terarah dan browser desktop lokal. Kontras WCAG 2.2 AA belum diukur; zoom, orientasi, keyboard penuh, VoiceOver/NVDA, serta perangkat mobile nyata belum diuji. Karena itu laporan tidak menyatakan kesesuaian WCAG sebagai terverifikasi.
