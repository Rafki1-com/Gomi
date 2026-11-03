# Gomi — Platform Random Video Chat V1.1

Gomi adalah aplikasi web full-stack untuk obrolan video acak satu lawan satu. Proyek ini menggunakan Node.js native HTTP/WebSocket, WebRTC untuk media video/audio, serta penyimpanan JSON untuk data moderasi. Tidak ada dependency npm pihak ketiga yang perlu diunduh.

## Fitur V1

- Pencocokan pengguna acak satu lawan satu dengan filter negara dua arah.
- Video dan audio langsung antar perangkat menggunakan WebRTC.
- UI responsif dengan ikon SVG konsisten dan kontrol yang lebih mudah dibaca.
- Panduan izin kamera/mikrofon di dalam aplikasi serta pesan error yang dibedakan berdasarkan penyebab browser.
- Pilihan negara pengguna dan negara teman yang dicari; tidak menggunakan GPS.
- Lewati/cari teman lain, mute mikrofon, matikan kamera, dan keluar sesi.
- Chat teks real-time selama sesi.
- Gate usia 18+ dengan tanggal lahir yang diperiksa lokal di browser dan tidak dikirim ke server.
- Laporkan dan blokir pengguna. Laporan otomatis memblokir akun sesi tersebut untuk pelapor.
- Data laporan, blokir, dan ban moderator disimpan di folder `DATA_DIR`.
- Dashboard moderator di `/admin`, dilindungi token admin.
- Pembatasan request dan event WebSocket, pemeriksaan origin, security headers, batas ukuran payload, dan render chat yang aman dari HTML injection.
- Endpoint health check `/api/health`.
- Dockerfile, Docker Compose, dan blueprint deployment Render.

## Menjalankan di komputer sendiri

Persyaratan: Node.js 22+ dan npm.

```bash
cp .env.example .env
```

Buka `.env`, lalu ganti `ADMIN_TOKEN` dengan secret acak yang panjang (contoh pembuatannya: `openssl rand -hex 32`). Setelah itu:

```bash
npm test
npm start
```

Buka `http://localhost:3000`. Kamera dan mikrofon dapat digunakan di `localhost`; deployment publik wajib menggunakan HTTPS.

Dashboard moderator tersedia di `http://localhost:3000/admin`. Masuk menggunakan nilai `ADMIN_TOKEN` di file `.env`.

> Proyek ini tidak memerlukan `npm install` karena runtime memakai modul bawaan Node.js saja.

## Menjalankan dengan Docker

```bash
cp .env.example .env
# Isi ADMIN_TOKEN di file .env
docker compose up --build -d
```

Folder `./data` dipasang sebagai persistent volume untuk menyimpan laporan, blokir, dan ban. Buat backup folder ini secara berkala.

## Deployment publik

File `render.yaml` dan `Dockerfile` sudah disertakan. Alur deployment Render:

1. Masukkan folder proyek ini ke repository GitHub milikmu.
2. Di Render, buat Blueprint baru dan pilih repository tersebut.
3. Render membaca `render.yaml`, membangun Docker image, dan membuat web service beserta persistent disk.
4. Masukkan `APP_ORIGIN` sesuai URL publik yang diberikan Render atau domain milikmu, misalnya `https://gomi.example.com` tanpa garis miring di akhir.
5. Isi `TURN_URLS` dan `TURN_SHARED_SECRET` dari server TURN milikmu.
6. Ambil nilai `ADMIN_TOKEN` yang dibuat otomatis oleh Blueprint dari dashboard Render, lalu simpan dengan aman.
7. Setelah deploy, buka `/api/health` dan `/admin` untuk memeriksa aplikasi dan dashboard moderasi.

Blueprint memakai paket Render `starter` dengan disk persisten 1 GB. Persistent disk Render hanya tersedia pada layanan web berbayar; filesystem biasa pada layanan Render bersifat ephemeral sehingga data laporan dapat hilang saat restart/deploy jika tidak memakai disk persisten. Lihat [dokumentasi Render Persistent Disks](https://render.com/docs/disks) dan [Blueprint YAML](https://render.com/docs/blueprint-spec).

### TURN server (sangat disarankan untuk produksi)

Aplikasi dapat berjalan dengan STUN saja, tetapi koneksi video di sebagian jaringan operator seluler, jaringan kantor, symmetric NAT, atau firewall ketat dapat gagal. Untuk penggunaan nyata, siapkan server TURN yang dikelola dan dimonitor.

Contoh konfigurasi Coturn dengan autentikasi shared secret:

```ini
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=GANTI_DENGAN_SECRET_ACAK_PANJANG
realm=turn.example.com
no-multicast-peers
no-loopback-peers
```

Atur variabel:

```text
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_SHARED_SECRET=GANTI_DENGAN_SECRET_YANG_SAMA
```

Gomi membuat kredensial TURN REST yang berlaku satu jam di server, lalu memberikannya ke browser melalui `/api/config`. Paket media dapat melewati TURN bila koneksi peer-to-peer langsung tidak memungkinkan. TURN meneruskan paket media, tetapi aplikasi Gomi tidak merekam atau menyimpan video/audio.

## Environment variables

| Variabel | Kegunaan |
|---|---|
| `PORT` | Port HTTP; default `3000`. Disediakan otomatis oleh sebagian hosting. |
| `HOST` | Alamat bind; default `0.0.0.0`. |
| `DATA_DIR` | Folder persisten untuk laporan, blokir, dan ban. |
| `APP_ORIGIN` | Origin publik yang diizinkan, contoh `https://gomi.example.com`. |
| `TRUST_PROXY` | `true` hanya jika berada di belakang reverse proxy tepercaya. |
| `ADMIN_TOKEN` | Secret untuk dashboard dan API moderasi. Admin nonaktif bila kosong. |
| `TURN_URLS` | Daftar endpoint TURN dipisahkan koma. |
| `TURN_SHARED_SECRET` | Shared secret Coturn REST API (direkomendasikan). |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | Alternatif kredensial TURN statis; kurang aman. |

Server membaca file `.env` otomatis saat tersedia. Environment variables yang sudah diberikan oleh hosting akan tetap diprioritaskan.

## Endpoint API

- `GET /api/health` — status server.
- `GET /api/config` — konfigurasi aplikasi dan ICE server.
- `GET /api/admin/reports` — daftar laporan dan ban (wajib Bearer admin token).
- `PATCH /api/admin/reports/:id` — status laporan: `open`, `reviewed`, atau `resolved`.
- `POST /api/admin/bans` — ban session ID; body `{ "userId": "<uuid>", "reason": "..." }`.
- `DELETE /api/admin/bans/:userId` — cabut ban moderator.

## Catatan penting sebelum dibuka untuk publik

Ini adalah **source code V1 lengkap dan siap di-deploy**, tetapi file proyek bukan berarti aplikasi sudah online. Untuk membuatnya live diperlukan akun hosting, repository, domain/URL publik, HTTPS, disk persisten, serta layanan TURN yang aktif.

1. **Verifikasi usia:** gate 18+ bawaan memeriksa tanggal lahir di browser dan meminta pernyataan pengguna. Ini bukan verifikasi identitas atau verifikasi usia pihak ketiga dan dapat dilewati oleh orang yang berbohong. Untuk layanan random video publik, tambahkan penyedia age assurance dan lakukan tinjauan hukum sesuai negara target.
2. **Operasional moderasi:** tetapkan moderator, prosedur respons, jadwal meninjau laporan, dan kebijakan retensi/penghapusan data.
3. **Anti-penyalahgunaan:** ID anonim browser bukan identitas terverifikasi. Pengguna yang berniat buruk dapat mengganti ID dengan menghapus data situs atau berganti perangkat. Pertimbangkan akun pengguna, risk scoring, dan perlindungan anti-abuse lebih kuat sebelum skala besar.
4. **Skala V1:** antrean matchmaking berada di memori satu proses dan JSON moderasi berada pada satu disk. Jalankan satu instance saja. Untuk multi-instance/horizontal scaling, pindahkan antrean ke Redis dan data moderasi ke database terkelola.
5. **TURN dan kapasitas:** uji panggilan lintas operator seluler dan jaringan terbatas; pantau biaya relay, kapasitas, serta keamanan TURN.
6. **Privasi dan hukum:** review Kebijakan Privasi dan Ketentuan Layanan dengan penasihat hukum, lalu tambahkan kontak dukungan dan proses permintaan data pengguna.
7. **Backup dan monitoring:** backup folder disk persisten dan pantau uptime, error rate, dan laporan penyalahgunaan.

## Desain privasi dan data

- Video/audio dikirim antar perangkat menggunakan WebRTC; media tidak ditulis ke penyimpanan Gomi.
- Server hanya meneruskan SDP dan ICE candidate ke pasangan yang sedang aktif.
- Pesan teks hanya diteruskan saat sesi berlangsung dan tidak disimpan.
- Laporan, blokir, serta ban moderator disimpan sebagai file JSON di `DATA_DIR`.
- Browser membuat UUID anonim dan menyimpannya secara lokal agar blokir bertahan untuk profil browser itu. Menghapus data situs akan membuat ID baru.
- Negara yang terlihat dipilih manual oleh pengguna, bukan berasal dari IP atau GPS.

## Pengujian

```bash
npm test
npm run check
```

Pengujian mencakup matchmaking, kompatibilitas filter negara, persistensi data moderasi, HTTP health/config, WebSocket matchmaking, relay signaling, chat real-time, laporan, dan endpoint admin.
