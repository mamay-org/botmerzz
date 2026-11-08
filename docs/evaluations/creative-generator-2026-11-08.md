# Evaluasi variasi generator — 8 November 2026

## Percobaan awal sebelum akses dipulihkan

Evaluasi non-publishing dengan model staging `google/gemini-3.8-flash`; tidak ada penilaian manusia. Riwayat 20 posting terbit terakhir: 10 top-up, 10 akun; 20 mengandung tanda tanya dan kata `korang`, 9 mengandung `sebelum`. Ini indikator leksikal, bukan ukuran kemiripan makna.

Rancangan adalah 20 konteks berpasangan, dua sampel per versi, mencakup kategori, kondisi fakta dan arahan admin; fakta kedaluwarsa atau kosong disimulasikan dalam memori. Pengujian terhenti karena OpenRouter merespons HTTP 403. Penyebab penolakan tidak diketahui; jangan menganggap akses, saldo, atau kuota sebagai penyebab tanpa pemeriksaan akun.

| Kondisi | Hasil tercatat | Siap | Ditolak ai_invalid_response | Rata-rata waktu | Input/output token dilaporkan | Biaya provider dilaporkan |
|---|---:|---:|---:|---:|---:|---:|
| Baseline | 19 | 6 | 13 | 21,5 dtk | 97.921 / 41.386 | 0,22863825 |
| Kandidat | 4 | 0 | 4 | 23,4 dtk | 23.251 / 9.810 | 0,05422575 |
| Kandidat temperature 0,8 | 1 | 0 | 1 | 21,0 dtk | 5.659 / 2.392 | 0,01321425 |

Biaya adalah nilai `cost` yang dikembalikan provider pada respons yang tercatat; mata uang tidak ditentukan di sini. Sampel tidak seimbang dan terlalu kecil untuk menyimpulkan perbedaan kualitas, variasi, latency, atau biaya. Tidak ada nilai sampling baru yang dipilih untuk default.

Probe menghasilkan `finish_reason=length` dengan 1.196 completion token, termasuk 1.151 reasoning token, pada batas 1.200. Respons ditolak oleh fail-closed. Probe budget 4.096 pada staging dan environment lokal saat itu menerima HTTP 403. Hasil setelah akses dipulihkan tercantum di bawah.

## Uji lanjutan setelah akses dipulihkan

Staging dipakai melalui SSH, tanpa dispatcher, penulisan database, atau posting. Semua kondisi memakai snapshot onboarding, fakta, riwayat, dan waktu yang sama. Dua kategori × lima kondisi fakta (`actual`, `fresh_simulated`, `stale`, `empty`, `inactive`) × dua variasi arahan menghasilkan 20 konteks. Baseline dan kandidat masing-masing dua sampel per konteks; eksperimen temperature 0,8 satu sampel per konteks. Timestamp yang dibuat segar adalah simulasi hanya di memori. Konteks bisnis dipaksa pada masing-masing kategori dengan menyesuaikan pillar riwayat dalam memori; ini bukan distribusi produksi alami.

Untuk perbandingan ini batas completion generator dinaikkan menjadi 4096 untuk **kedua versi**; auditor tetap 800 dan tanpa parameter sampling eksperimen. Hasil ini tidak langsung sebanding dengan baseline 1200 token yang terpotong di atas. Semua panggilan ke `google/gemini-3.8-flash`; angka biaya berasal dari field usage provider dan tidak mencakup kegagalan HTTP tanpa usage.

| Kondisi | Konteks / percobaan | Siap | Dilewati | Mean / median detik | Input / output token | Biaya provider |
|---|---:|---:|---:|---:|---:|---:|
| Baseline 4096 | 20 / 40 | 40 | 0 | 22,19 / 19,18 | 152.773 / 95.662 | 0,47331225 |
| Kandidat 4096 | 20 / 40 | 36 | 4 | 26,72 / 21,87 | 163.468 / 119.810 | 0,57188850 |
| Kandidat temperature 0,8 | 20 / 20 | 20 | 0 | 22,84 / 21,83 | 74.759 / 53.142 | 0,25535175 |

Empat kandidat dilewati setelah percobaan ulang: satu `CAPTION_TOO_LONG`, tiga `SEMANTIC_VALIDATION_FAILED`. Jumlah request provider masing-masing 91, 94, dan 43; percobaan yang membutuhkan retry masing-masing 6, 8, dan 2. Perbedaan biaya dan latency mencakup retry serta perbedaan output; ukuran sampel belum cukup untuk inferensi statistik.

Indikator otomatis untuk caption siap: tanda tanya dalam kalimat pertama 16/40 baseline, 6/36 kandidat, 2/20 temperature 0,8; tanda tanya dalam kalimat penutup 40/40, 30/36, 19/20. Kalimat dipecah berdasarkan `.`, `!`, `?` setelah tautan dan hashtag dihapus, sehingga angka/format bahasa dapat memengaruhi hasil. Awalan tiga kata terbanyak baseline `nak tanya sikit` (12/40), kandidat `bila nak top` (4/36), temperature `bila nak top` (4/20). Penutup tiga kata terbanyak `korang jenis yang` masing-masing 13/40, 11/36, 8/20. Ini indikator bentuk, bukan penilaian kreativitas atau makna.

Semua pasangan caption siap dalam setiap versi dibandingkan menggunakan Jaccard himpunan kata setelah tautan dan hashtag dihapus: skor ≥0,75 muncul 0/780 baseline, 0/630 kandidat dan 0/190 temperature. Ini tidak mengukur repetisi semantik; skor nol tidak menunjukkan konten beragam secara makna. Pengujian otomatis dan auditor bukan bukti bahwa setiap klaim benar atau bahasa natural. Belum ada penilaian manusia buta. Temperature 0,8 juga hanya memiliki satu sampel/konteks; tidak cukup bukti untuk mengubah default.

Klasifikasi tema leksikal berbasis kata kunci dapat tumpang tindih dan tidak memverifikasi topik sesungguhnya. Karena itu kesimpulan P3 belum dapat dipastikan; lakukan penilaian manusia terhadap pasangan konteks yang sama, termasuk hasil ditolak dan pilihan sudut, sebelum menambahkan similarity semantik atau memilih parameter default. Probe dengan batas 4096 menghasilkan tiga hasil (dua siap, satu ditolak) dan seluruh respons yang tercatat `finish_reason=stop`; ini bukti terbatas, bukan jaminan model tidak akan mencapai batas.
