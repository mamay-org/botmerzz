# MAMAY-HOMELAB-INGRESS-SSOT.md
## Single Source of Truth — Proxmox Ingress Gateway (Traefik v3 & Cloudflare Tunnel)

> **Status Dokumen:** Production Baseline v1.2 — Comprehensive DevOps Edition.
> **Target Environment:** Proxmox VE Server Mamay (Node Homelab).
> **Klasifikasi:** Internal Operational Runbook & Single Source of Truth (SSOT).
> **Tujuan:** Menjadi satu-satunya acuan resmi dan lengkap bagi administrator sistem, insinyur DevOps, dan AI Coding Agent untuk merancang, menginstal, mengonfigurasi, mengoperasikan, menambah layanan, dan memitigasi kendala pada stack Ingress Gateway terpusat serta alur deployment aplikasi backend.
> **Ruang Lingkup:** Seluruh komponen Ingress Gateway pada LXC 10080 (`gateway-ingress`), konfigurasi Proxmox LXC, Docker Engine, Cloudflare Tunnel remote-managed via Zero Trust Dashboard, Traefik v3 Reverse Proxy, mekanisme Dynamic File Provider untuk routing ke LXC/VM backend, serta **Standar Operasional CI/CD In-LXC Homelab (GitHub Actions Self-Hosted Runner tanpa registri GHCR)** untuk build & deploy aplikasi secara otomatis pada masing-masing LXC target.

---

## 1. Parameter Infrastruktur & Jaringan (Terverifikasi)

Seluruh parameter di bawah ini adalah konfigurasi aktif yang telah divalidasi pada infrastruktur Server Mamay:

| Parameter | Nilai / Ketetapan | Status | Keterangan & Lokasi Konfigurasi |
|---|---|---|---|
| **Hypervisor Host** | Proxmox VE (Server Mamay) | Terverifikasi | Server fisik Mini PC / Homelab |
| **Subnet LAN Utama** | `192.168.0.0/24` | Terverifikasi | Jaringan lokal fisik seluruh node & LXC |
| **Default Gateway LAN** | `192.168.0.1` | Terverifikasi | IP Router fisik (ISP/Mikrotik) |
| **Gateway LXC ID** | `10080` | Terverifikasi | ID container Proxmox khusus Ingress |
| **Gateway Hostname** | `gateway-ingress` | Terverifikasi | Hostname OS di `/etc/hostname` |
| **Gateway IP (Statis)** | `192.168.0.80/24` | Terverifikasi | Alamat IP statis pada interface `eth0` |
| **Gateway MAC / Bridge** | `vmbr0` | Terverifikasi | Linux Bridge default Proxmox |
| **DNS Upstream** | `1.1.1.1`, `8.8.8.8` | Terverifikasi | Resolver upstream di `/etc/resolv.conf` |
| **LXC Features** | `nesting=1, keyctl=1` | Terverifikasi | Wajib untuk Docker Engine unprivileged di PVE |
| **LXC Resource Baseline**| 2 Core CPU, 2048 MB RAM, 16 GB Disk | Rekomendasi | Alokasi ideal untuk gateway reverse proxy |
| **OS Template LXC** | Debian 13 (Trixie)  | Standar | Minimal OS image |
| **Docker Engine** | Docker CE (Latest stable) + Compose Plugin | Terverifikasi | Runtime container di dalam LXC 10080 |
| **Docker Network** | `web-gateway` | Terverifikasi | External bridge network (`driver: bridge`) |
| **Working Directory** | `/opt/ingress` | Terverifikasi | Direktori stack Compose & `.env` |
| **Dynamic Config Dir** | `/opt/ingress/dynamic` | Terverifikasi | Mount host ke `/etc/traefik/dynamic:ro` |
| **Reverse Proxy Engine** | Traefik `v3.1` | Terverifikasi | Entrypoint `:80` (HTTP internal) |
| **Tunnel Provider** | Cloudflare Tunnel (`cloudflared`) | Terverifikasi | Image `cloudflare/cloudflared:latest` |
| **Tunnel Management** | Remote-managed (Token-based) | Terverifikasi | Dikelola via Cloudflare Zero Trust Dashboard |
| **Traefik Dashboard** | `http://192.168.0.80:8080/dashboard/` | Terverifikasi | Mode `--api.insecure=true`, dibatasi khusus LAN |

---

## 2. Arsitektur & Topologi Aliran Trafik

Sistem ini menggunakan pola **Egress-Only Reverse Tunnel**. Server homelab tidak memerlukan IP publik statis, DDNS, maupun port forwarding pada router lokal (Port 80/443 di router fisik tetap tertutup dari internet).

```text
                                  INTERNET
                                      │
                                      ▼ HTTPS (Port 443)
                      ┌───────────────────────────────┐
                      │    Cloudflare Global Edge     │
                      │  - Anycast DNS & Edge SSL     │
                      │  - Web Application Firewall   │
                      │  - DDoS Protection & Caching  │
                      └───────────────┬───────────────┘
                                      │
                                      │ Outbound Encrypted Tunnel
                                      │ (QUIC / HTTP2 via UDP/TCP 7844)
                                      ▼
                      ┌───────────────────────────────┐
                      │    Router Fisik (192.168.0.1) │
                      │    (Tanpa Port Forwarding)    │
                      └───────────────┬───────────────┘
                                      │ Jaringan LAN (192.168.0.0/24)
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Proxmox VE Host — Server Mamay (Bridge: vmbr0)                              │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ LXC 10080: gateway-ingress (IP: 192.168.0.80)                         │  │
│  │                                                                       │  │
│  │   Docker Bridge Network: web-gateway                                  │  │
│  │   ┌───────────────────────────┐       ┌───────────────────────────┐   │  │
│  │   │ Container: cloudflared    │──────►│ Container: traefik:v3.1   │   │  │
│  │   │ (Tunnel Client)           │ HTTP  │ (Reverse Proxy Core)      │   │  │
│  │   │ Token-based Zero Trust    │ :80   │ Entrypoint :80            │   │  │
│  │   └───────────────────────────┘       └─────────────┬─────────────┘   │  │
│  │                                                     │                 │  │
│  │   Traefik Dashboard: :8080 (LAN Only)               │                 │  │
│  │   Dynamic Config: /opt/ingress/dynamic/*.yml        │                 │  │
│  └─────────────────────────────────────────────────────┼─────────────────┘  │
│                                                        │                    │
│                        Meneruskan Request via LAN      │                    │
│                        (HTTP/REST/WebSocket/TCP)       │                    │
│                                                        ▼                    │
│    ┌─────────────────────────┬─────────────────────────┬───────────────┐    │
│    │                         │                         │               │    │
│    ▼                         ▼                         ▼               ▼    │
│ ┌──────────────────────┐  ┌──────────────────────┐  ┌───────────────┐  ┌──┐ │
│ │ LXC 101: App Web     │  │ LXC 102: API Service │  │ VM 200: DB/UI │  │..│ │
│ │ 192.168.0.101:3000   │  │ 192.168.0.102:8080   │  │ 192.168.0.200 │  │  │ │
│ └──────────────────────┘  └──────────────────────┘  └───────────────┘  └──┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Alur Pemrosesan Request (Hop-by-Hop)
1. **Request Masuk:** Klien internet mengakses `https://app.domainmamay.com`.
2. **Terminasi SSL di Edge:** Cloudflare Edge menangani sertifikat TLS/SSL publik, inspeksi WAF, dan proteksi DDoS.
3. **Tunnel Egress:** Paket diteruskan melalui tunnel QUIC aktif ke container `cloudflared` yang berjalan di LXC 10080.
4. **Proxy Internal Docker:** `cloudflared` meneruskan paket ke `http://traefik:80` melalui Docker bridge `web-gateway`.
5. **Pencocokan Aturan di Traefik:** Traefik membaca header `Host: app.domainmamay.com`, lalu mencocokkannya dengan router di File Provider (`/opt/ingress/dynamic/*.yml`).
6. **Penerusan ke Target Homelab:** Traefik meneruskan request melalui antarmuka `eth0` LXC 10080 ke alamat IP LAN target (misal `http://192.168.0.101:3000`).

---

## 3. Spesifikasi Konfigurasi Proxmox Host (LXC 10080)

Bagi staff DevOps yang membuat atau memvalidasi LXC Ingress di Proxmox VE, konfigurasi container harus mematuhi spesifikasi berikut.

### 3.1 File Konfigurasi PVE: `/etc/pve/lxc/10080.conf`
```text
arch: amd64
cores: 2
features: nesting=1,keyctl=1
hostname: gateway-ingress
memory: 2048
nameserver: 1.1.1.1 8.8.8.8
net0: name=eth0,bridge=vmbr0,gw=192.168.0.1,ip=192.168.0.80/24,type=veth
onboot: 1
ostype: debian
rootfs: local-lvm:subvol-10080-disk-0,size=16G
swap: 1024
unprivileged: 1
```

> [!IMPORTANT]
> - `unprivileged: 1`: Standar keamanan isolasi container Proxmox.
> - `nesting=1`: Wajib agar Docker daemon dapat membuat namespace cgroups dan veth di dalam LXC.
> - `keyctl=1`: Wajib untuk Docker unprivileged agar caching kredensial dan overlay2 berjalan stabil tanpa permission error.
> - `onboot: 1`: Memastikan Ingress Gateway otomatis menyala saat server fisik Proxmox boot.

### 3.2 Pembuatan LXC via PVE CLI (Opsional / Disaster Recovery)
Jika perlu merekonstruksi container dari Proxmox Host shell:
```bash
pct create 10080 local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst \
  --hostname gateway-ingress \
  --cores 2 \
  --memory 2048 \
  --swap 1024 \
  --features nesting=1,keyctl=1 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.0.80/24,gw=192.168.0.1 \
  --nameserver "1.1.1.1 8.8.8.8" \
  --rootfs local-lvm:16 \
  --unprivileged 1 \
  --onboot 1

# Masuk ke container setelah start
pct start 10080
pct enter 10080
```

---

## 4. Spesifikasi Stack Docker Ingress

### 4.1 Layout Direktori Kerja
```text
/opt/ingress/
├── .env                  # Token Cloudflare Tunnel (Permissions: 600)
├── docker-compose.yml    # Definisi service Traefik & Cloudflared
└── dynamic/              # Direktori konfigurasi dinamis Traefik (Hot reload)
    ├── service-template.yml.example
    ├── secured-service-template.yml.example
    └── (file-file routing .yml untuk masing-masing layanan...)
```

### 4.2 File Environment: `/opt/ingress/.env`
```ini
# Cloudflare Tunnel Token
# Diambil dari Cloudflare One Dashboard (Networks > Tunnels)
TUNNEL_TOKEN=eyJhIjoi...PASTE_CLOUDFLARE_TUNNEL_TOKEN_HERE...
```

> [!CAUTION]
> Token ini memberi akses penuh untuk menyambungkan konektor ke akun Cloudflare Anda.
> - Jangan pernah melakukan commit file `.env` ke repositori Git.
> - Berikan hak akses terbatas:
>   ```bash
>   chmod 600 /opt/ingress/.env
>   chown root:root /opt/ingress/.env
>   ```

### 4.3 File Stack: `/opt/ingress/docker-compose.yml`
```yaml
services:
  traefik:
    image: traefik:v3.1
    container_name: traefik
    restart: unless-stopped
    command:
      # Dashboard & API
      - "--api.dashboard=true"
      - "--api.insecure=true"
      # Provider Docker (untuk container lokal di LXC 10080 jika ada)
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      # Provider File (Koneksi utama ke LXC/VM homelab)
      - "--providers.file.directory=/etc/traefik/dynamic"
      - "--providers.file.watch=true"
      # Entrypoints
      - "--entrypoints.web.address=:80"
      # Logging level (INFO / WARN / ERROR / DEBUG)
      - "--log.level=INFO"
    ports:
      - "80:80"        # HTTP Entrypoint internal
      - "8080:8080"    # Traefik Web Dashboard (Akses LAN privat)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/ingress/dynamic:/etc/traefik/dynamic:ro
    networks:
      - web-gateway

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: cloudflared
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${TUNNEL_TOKEN}
    networks:
      - web-gateway
    depends_on:
      - traefik

networks:
  web-gateway:
    external: true
```

---

## 5. Mekanisme Dynamic File Provider & Konfigurasi Routing

Karena backend berada di LXC/VM terpisah pada jaringan Proxmox, Docker daemon di gateway tidak memiliki visibilitas ke container di LXC lain. **Dynamic File Provider adalah mekanisme wajib** untuk menghubungkan Traefik ke layanan backend di seluruh homelab.

### 5.1 Standar Penamaan Unik (Global Unique Rule)
Di Traefik, semua nama router, service, dan middleware harus **unik secara global**.
- Rekomendasi Router: `<nama_layanan>-router` (misal: `uptime-kuma-router`)
- Rekomendasi Service: `<nama_layanan>-service` (misal: `uptime-kuma-service`)
- Rekomendasi Middleware: `<nama_layanan>-<fungsi>-mw` (misal: `api-strip-mw`)

### 5.2 Template 1: Layanan Web HTTP Standar (`/opt/ingress/dynamic/app-template.yml`)
Gunakan template ini untuk aplikasi web biasa (Next.js, Portainer, Uptime Kuma, dsb.):
```yaml
http:
  routers:
    app-template-router:
      rule: "Host(`app.domainmamay.com`)"
      entryPoints:
        - web
      service: app-template-service

  services:
    app-template-service:
      loadBalancer:
        servers:
          - url: "http://192.168.0.101:3000"
        passHostHeader: true
```

### 5.3 Template 2: Layanan API dengan Header Keamanan (`/opt/ingress/dynamic/api-template.yml`)
Gunakan template ini untuk REST API, webhook, atau layanan backend yang memerlukan sanitasi header:
```yaml
http:
  routers:
    api-template-router:
      rule: "Host(`api.domainmamay.com`)"
      entryPoints:
        - web
      middlewares:
        - common-security-headers
      service: api-template-service

  middlewares:
    common-security-headers:
      headers:
        sslRedirect: false # Terminasi SSL ditangani Cloudflare Edge
        browserXssFilter: true
        contentTypeNosniff: true
        frameDeny: true
        customRequestHeaders:
          X-Forwarded-Proto: "https"

  services:
    api-template-service:
      loadBalancer:
        servers:
          - url: "http://192.168.0.102:8080"
        passHostHeader: true
```

### 5.4 Template 3: Layanan dengan Path-Prefix / Strip-Prefix
Jika backend berjalan pada subpath tetapi diakses tanpa subpath:
```yaml
http:
  routers:
    prefixed-app-router:
      rule: "Host(`console.domainmamay.com`) && PathPrefix(`/admin`)"
      entryPoints:
        - web
      middlewares:
        - strip-admin-prefix
      service: prefixed-app-service

  middlewares:
    strip-admin-prefix:
      stripPrefix:
        prefixes:
          - "/admin"

  services:
    prefixed-app-service:
      loadBalancer:
        servers:
          - url: "http://192.168.0.103:9000"
```

---

## 6. Konfigurasi Cloudflare Zero Trust (Remote-Managed Tunnel)

Seluruh konfigurasi domain dipetakan melalui Cloudflare One Dashboard, bukan melalui file lokal `config.yml`.

### 6.1 Membuat Tunnel Baru
1. Buka [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) -> **Networks** -> **Tunnels**.
2. Klik **Add a tunnel** -> Pilih tipe connector: **Cloudflared**.
3. Masukkan nama tunnel: `mamay-ingress-tunnel`.
4. Pada layar instalasi konektor, pilih **Docker**.
5. Salin string token setelah parameter `--token` (format JWT panjang).
6. Masukkan token tersebut ke dalam `/opt/ingress/.env`.

### 6.2 Memetakan Public Hostname (Aturan Baku)
Setiap layanan baru di homelab **wajib** dipetakan dengan aturan baku:
- **Subdomain:** nama subdomain (misal `git`, `grafana`, `home`)
- **Domain:** domain terdaftar Anda di Cloudflare (misal `domainmamay.com`)
- **Path:** biarkan kosong (kecuali spesifik)
- **Type:** `HTTP`
- **URL:** `traefik:80` *(PENTING: Jangan masukkan IP LAN di sini. Gunakan selalu `traefik:80`)*

> [!NOTE]
> Nama host `traefik` dapat dikenali oleh `cloudflared` karena keduanya berada di dalam Docker bridge network yang sama (`web-gateway`). Traefik yang bertugas mencocokkan header `Host` dan meneruskannya ke IP LAN backend yang sebenarnya.

---

## 7. Batasan Arsitektur & Keamanan (Security Constraints)

1. **Isolasi Bridge Network Antar-LXC:**
   Docker network `web-gateway` hanya beroperasi di dalam kernel namespace LXC 10080. Container di LXC lain tidak dapat di-attach ke network ini. Komunikasi antar-LXC wajib menggunakan rute IP LAN fisik (`192.168.0.0/24`).
2. **Mounting Docker Socket (`/var/run/docker.sock:ro`):**
   Mode mount `:ro` hanya membatasi perubahan filesystem pada socket; itu tidak membatasi operasi melalui Docker API. Proses Traefik yang dapat mengakses socket berpotensi mengendalikan Docker Engine dan container lain pada LXC 10080. Sebelum mengandalkan konfigurasi ini, pastikan kebutuhan Docker provider dan risiko tersebut telah ditinjau. Jika discovery label Docker tidak diperlukan, nonaktifkan Docker provider dan hapus mount socket. Jika masih diperlukan, gunakan socket proxy dengan allowlist endpoint baca-saja yang sesuai. Akses socket saat ini belum diverifikasi di LXC.
3. **Traefik Dashboard Insecure Mode (`:8080`):**
   Flag `--api.insecure=true` mengaktifkan web GUI tanpa autentikasi pada port `8080`.
   - **Aturan Akses:** Batasi port dashboard dengan firewall LXC ke LAN internal (`192.168.0.0/24`) atau koneksi privat (Tailscale/WireGuard). Pemetaan port Compose `8080:8080` sendiri tidak menjamin akses LAN saja.
   - **Larangan Keras:** DILARANG membuat Public Hostname di Cloudflare Zero Trust yang mengarah ke port `8080`.
4. **Mekanisme Inotify di Linux LXC:**
   Opsi `--providers.file.watch=true` menggunakan Linux *inotify kernel events*.
   - Selalu buat, ubah, atau hapus file YAML langsung di dalam shell LXC 10080 (`/opt/ingress/dynamic/`).
   - Jika file disunting dari host Proxmox langsung ke bind-mount, trigger inotify mungkin tidak terkirim ke container Traefik.
5. **Real IP Forwarding:**
   Cloudflare Edge menyertakan IP asli klien pada HTTP header `CF-Connecting-IP`. Traefik meneruskan request dengan header standar `X-Forwarded-For` dan `X-Forwarded-Proto: https`. Pastikan aplikasi backend di-configure untuk mempercayai upstream IP Traefik (`192.168.0.80`).

---

## 8. Runbook Step-by-Step: Instalasi & Inisialisasi Stack (DevOps)

Jalankan prosedur ini dari nol pada LXC 10080 yang baru dibuat:

```bash
# -------------------------------------------------------------
# LANGKAH 1: Persiapan OS & Instalasi Docker CE di LXC 10080
# -------------------------------------------------------------
apt-get update && apt-get upgrade -y
apt-get install -y ca-certificates curl gnupg lsb-release nano htop net-tools

# Menambahkan Docker Official GPG Key & Repository
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Aktifkan dan jalankan service Docker
systemctl enable --now docker

# -------------------------------------------------------------
# LANGKAH 2: Inisialisasi Direktori & Network Gateway
# -------------------------------------------------------------
mkdir -p /opt/ingress/dynamic
cd /opt/ingress

# Buat network bridge eksternal (WAJIB)
docker network create web-gateway

# -------------------------------------------------------------
# LANGKAH 3: Pembuatan Konfigurasi Stack
# -------------------------------------------------------------
# Buat file .env dengan token Cloudflare Tunnel
cat << 'EOF' > /opt/ingress/.env
TUNNEL_TOKEN=eyJhIjoi...GANTI_DENGAN_TOKEN_CLOUDFLARE_ANDA...
EOF
chmod 600 /opt/ingress/.env

# Salin docker-compose.yml sesuai Bagian 4.3 dokumen ini
# Jalankan stack
docker compose up -d

# -------------------------------------------------------------
# LANGKAH 4: Verifikasi Status Awal
# -------------------------------------------------------------
docker compose ps
```

---

## 9. Standard Operating Procedure (SOP): Penambahan Layanan Baru

Setiap kali tim DevOps ingin menghubungkan aplikasi baru ke internet via domain publik:

### Tahap 1: Persiapan & Validasi Backend
1. Pastikan aplikasi target berjalan di LXC/VM dengan IP statis pada subnet `192.168.0.0/24` (contoh: LXC 101 pada `192.168.0.101:3000`).
2. Pastikan service backend mendengarkan pada interface yang dapat diakses LAN (`0.0.0.0` atau `192.168.0.101`), bukan `127.0.0.1`.
3. Dari terminal LXC 10080, lakukan uji jangkauan jaringan:
   ```bash
   curl -I http://192.168.0.101:3000
   ```
   *(Harus mengembalikan respons HTTP status code seperti 200, 301, 302, 401, atau 404. Jika timeout, periksa firewall UFW atau PVE firewall).*

### Tahap 2: Buat File Routing di Traefik Dynamic Provider
1. Di dalam LXC 10080, buat file baru:
   ```bash
   nano /opt/ingress/dynamic/my-app.yml
   ```
2. Isi file menggunakan format baku:
   ```yaml
   http:
     routers:
       my-app-router:
         rule: "Host(`app.domainmamay.com`)"
         entryPoints:
           - web
         service: my-app-service

     services:
       my-app-service:
         loadBalancer:
           servers:
             - url: "http://192.168.0.101:3000"
   ```
3. Simpan file. Traefik otomatis membaca perubahan tanpa restart container.
4. Buka Traefik Dashboard di browser LAN: `http://192.168.0.80:8080/dashboard/`.
   - Buka menu **HTTP Routers** -> Pastikan `my-app-router` muncul dan berstatus **OK (Hijau)**.
   - Buka menu **HTTP Services** -> Pastikan `my-app-service` terdaftar mengarah ke IP `192.168.0.101:3000`.

### Tahap 3: Daftarkan Public Hostname di Cloudflare Zero Trust
1. Buka [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) -> **Networks** -> **Tunnels** -> Pilih `mamay-ingress-tunnel`.
2. Klik tab **Public Hostname** -> **Add a public hostname**.
3. Konfigurasi:
   - **Subdomain:** `app`
   - **Domain:** `domainmamay.com`
   - **Type:** `HTTP`
   - **URL:** `traefik:80`
4. Klik **Save hostname**.

### Tahap 4: Uji Coba End-to-End & Update Inventaris
1. Akses dari browser publik: `https://app.domainmamay.com`.
2. Catat layanan yang telah aktif ke dalam tabel **Inventaris Layanan** (Bagian 11).

---

## 10. Standar Operasional CI/CD In-LXC (Self-Hosted Runner Tanpa GHCR)

Sistem homelab ini menerapkan arsitektur **Zero-Registry In-LXC CI/CD**. Berbeda dengan alur cloud konvensional yang membutuhkan push/pull image ke registri eksternal (seperti GitHub Container Registry / GHCR atau Docker Hub), seluruh proses penarikan kode, kompilasi Dockerfile, dan reload kontainer dieksekusi secara lokal langsung di dalam LXC aplikasi terkait (misal: repositori `web1` di-build & deploy di LXC 100, `web2` di LXC 101).

> [!NOTE]
> **Keunggulan Pendekatan In-LXC Homelab:**
> - **Efisiensi Bandwidth Homelab:** Tidak ada proses upload image raksasa ke internet publik lalu men-download-nya kembali ke server lokal.
> - **Kecepatan Build (Local Layer Caching):** Engine Docker BuildKit memanfaatkan layer cache lokal di SSD Proxmox, membuat proses build jauh lebih cepat.
> - **Keamanan Kredensial (Air-Gapped Secrets):** File `.env` produksi tersimpan permanen di host LXC dan tidak pernah dikirim ke runner cloud atau log GitHub.

### 10.1 Arsitektur & Topologi Aliran CI/CD In-LXC

```text
[ Developer ] ── (git push origin main) ──► [ GitHub Repository ]
                                                    │
                                                    │ Webhook / Polling Job Event
                                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Proxmox VE Host — Node Homelab (Bridge: vmbr0)                              │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ Target App LXC (misal: LXC 100 'web1' / LXC 101 'web2')               │  │
│  │ IP: 192.168.0.100/24 (atau 101)                                       │  │
│  │                                                                       │  │
│  │   ┌───────────────────────────────────────────────────────────────┐   │  │
│  │   │ GitHub Actions Self-Hosted Runner Service (Systemd)           │   │  │
│  │   │ User: runner (Group: docker)                                  │   │  │
│  │   │ Custom Label: [self-hosted, linux, x64, web1]                 │   │  │
│  │   └───────────────────────────────┬───────────────────────────────┘   │  │
│  │                                   │                                   │  │
│  │     1. actions/checkout@v4        │ 2. Sinkronisasi Source Code       │  │
│  │        (Tarik commit lokal)       ▼    (Tanpa menimpa .env lokal)     │  │
│  │   ┌───────────────────────────────────────────────────────────────┐   │  │
│  │   │ Direktori Produksi: /opt/<nama-app> (misal /opt/web1)         │   │  │
│  │   │ - .env (Statis & Rahasia, Permissions 600, Milik Host)        │   │  │
│  │   │ - docker-compose.yml                                          │   │  │
│  │   │ - Dockerfile & App Source Code                                │   │  │
│  │   └───────────────────────────────┬───────────────────────────────┘   │  │
│  │                                   │                                   │  │
│  │     3. docker compose up -d       │ 4. Build Image Lokal (No GHCR)    │  │
│  │        --build --remove-orphans   ▼                                   │  │
│  │   ┌───────────────────────────────────────────────────────────────┐   │  │
│  │   │ Docker Engine (Local Daemon di dalam LXC)                     │   │  │
│  │   │ - Mengkompilasi container aplikasi secara in-place            │   │  │
│  │   │ - Menjalankan kontainer pada port aplikasi (misal :3000)      │   │  │
│  │   └───────────────────────────────┬───────────────────────────────┘   │  │
│  │                                   │                                   │  │
│  │     5. curl -f http://127.0.0.1:3000 (Health Check)                   │  │
│  │     6. docker image prune -f         (Storage Cleanup)                │  │
│  │                                   ▼                                   │  │
│  │                          [ Deployment Sukses ]                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                      ▲                                      │
│                                      │ Trafik HTTP Terbuka via LAN          │
│  ┌───────────────────────────────────┴───────────────────────────────────┐  │
│  │ LXC 10080 (gateway-ingress): Traefik v3 ──► Forward ke 192.168.0.X:PORT │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 10.2 Prasyarat Konfigurasi LXC Target di Proxmox VE

Agar LXC target dapat menjalankan Docker Engine dan bertindak sebagai runner lokal, container harus memenuhi spesifikasi Proxmox berikut:

#### 1. Fitur Kernel LXC (`/etc/pve/lxc/<ID>.conf`)
Periksa konfigurasi container di host Proxmox (contoh `/etc/pve/lxc/100.conf`):
```text
features: nesting=1,keyctl=1
```
> [!IMPORTANT]
> - `nesting=1`: Wajib agar Docker dapat membuat cgroup & namespace jaringan di dalam LXC unprivileged.
> - `keyctl=1`: Menghindari permission error pada storage driver Docker `overlay2`.
> - Jika fitur ini belum aktif, jalankan di shell Proxmox Host:
>   ```bash
>   pct set <ID> -features nesting=1,keyctl=1
>   pct reboot <ID>
>   ```

#### 2. Rekomendasi Alokasi Resource LXC Aplikasi
- **Disk Space:** Minimal 20 GB – 32 GB (proses build Docker lokal dan layer caching membutuhkan cadangan ruang disk).
- **RAM & CPU:** Minimal 2 vCPU dan 2048 MB RAM (sesuaikan dengan beban kompilasi bahasa/framework seperti Next.js, Node.js, atau Go).

---

### 10.3 Runbook Setup Self-Hosted Runner di LXC Target

Jalankan prosedur ini satu kali pada setiap LXC aplikasi (misal LXC 100 untuk `web1` atau LXC 101 untuk `web2`):

```bash
# -------------------------------------------------------------
# LANGKAH 1: Persiapan Dependensi & User Khusus Runner
# -------------------------------------------------------------
# Pastikan Docker CE & utilitas dasar sudah terpasang di LXC
apt-get update && apt-get install -y curl tar jq rsync git sudo

# Buat user non-root khusus 'runner' (standar keamanan GitHub Actions Runner)
id -u runner &>/dev/null || adduser --disabled-password --gecos "" runner

# Berikan hak akses Docker kepada user runner (tanpa perlu sudo root)
usermod -aG docker runner

# Standarisasi direktori aplikasi /opt/<nama-app>
# (Contoh untuk aplikasi 'web1')
APP_NAME="web1"
mkdir -p /opt/${APP_NAME}
chown -R runner:runner /opt/${APP_NAME}

# -------------------------------------------------------------
# LANGKAH 2: Unduh & Konfigurasi GitHub Actions Runner
# -------------------------------------------------------------
# Masuk sebagai user runner
su - runner
mkdir -p ~/actions-runner && cd ~/actions-runner

# Unduh binary runner resmi terbaru (arsitektur x64 linux)
RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r '.tag_name' | sed 's/v//')
curl -o actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz -L \
  https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz

tar xzf ./actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz

# Registrasi runner ke GitHub Repository terkait
# (Token didapatkan dari: GitHub Repo -> Settings -> Actions -> Runners -> New self-hosted runner)
# PENTING: Berikan custom label spesifik nama aplikasi (misal: web1)
./config.sh \
  --url https://github.com/<USERNAME_ATAU_ORG>/<NAMA_REPO> \
  --token <REGISTRATION_TOKEN_DARI_GITHUB> \
  --name "lxc-<ID>-${APP_NAME}" \
  --labels "self-hosted,linux,x64,${APP_NAME}" \
  --work "_work" \
  --unattended

exit # Kembali ke user root

# -------------------------------------------------------------
# LANGKAH 3: Daftarkan & Jalankan Runner sebagai Systemd Daemon
# -------------------------------------------------------------
cd /home/runner/actions-runner
./svc.sh install runner
./svc.sh start

# Periksa status daemon runner
./svc.sh status
```

> [!TIP]
> Status runner akan langsung muncul sebagai **Idle (Hijau)** pada menu repositori GitHub: **Settings > Actions > Runners**.

---

### 10.4 Standarisasi Direktori Produksi & Pengamanan `.env`

Untuk menjaga konsistensi dengan Ingress Gateway di `/opt/ingress`, seluruh aplikasi backend distandarisasi di direktori `/opt/<nama-aplikasi>`.

#### Layout Direktori `/opt/<nama-aplikasi>/`:
```text
/opt/web1/
├── .env                  # Rahasia produksi (chmod 600, TIDAK di-commit ke Git)
├── docker-compose.yml    # Definisi service & port binding internal
├── Dockerfile            # Blueprint build image aplikasi
└── src/                  # Kode sumber aplikasi yang disinkronkan oleh CI/CD
```

#### Tata Kelola File `.env` Produksi:
1. Siapkan file `.env` langsung di dalam server LXC satu kali saat inisialisasi:
   ```bash
   cat << 'EOF' > /opt/web1/.env
   NODE_ENV=production
   PORT=3000
   DATABASE_URL=postgresql://user:secret@192.168.0.200:5432/web1_db
   SECRET_KEY=kunci_rahasia_homelab_yang_sangat_panjang
   EOF

   # Kunci hak akses agar hanya user root dan runner yang dapat membaca
   chmod 600 /opt/web1/.env
   chown runner:runner /opt/web1/.env
   ```
2. Workflow CI/CD **dilarang menimpa atau menghapus** file `.env` ini. Source code yang di-checkout dari GitHub akan disinkronkan ke `/opt/<nama-aplikasi>/` dengan proteksi `--exclude='.env'`.

---

### 10.5 Template Produksi Workflow GitHub Actions (`.github/workflows/deploy.yml`)

Simpan template workflow ini di dalam repositori kode aplikasi pada `.github/workflows/deploy.yml`.
Workflow ini berjalan **100% lokal di dalam LXC**, tanpa menggunakan kuota menit build GitHub Cloud dan tanpa registri container:

```yaml
name: Local In-LXC CI/CD Deployment

on:
  push:
    branches:
      - main
      - master
  workflow_dispatch: # Memungkinkan trigger manual via UI GitHub Actions

concurrency:
  group: production-deploy-${{ github.ref }}
  cancel-in-progress: false # Cegah deploy bersamaan saling bertabrakan

jobs:
  deploy:
    name: Build & In-Place Deploy on Target LXC
    # Wajib mencocokkan custom label runner pada LXC target (contoh: web1)
    runs-on: [self-hosted, linux, x64, web1]

    env:
      APP_DIR: /opt/web1
      APP_PORT: 3000

    steps:
      - name: Checkout Source Code
        uses: actions/checkout@v4

      - name: Sync Source Code to Production Directory
        run: |
          echo ">>> Mensinkronkan file repository ke direktori produksi $APP_DIR..."
          # rsync file repo ke /opt/web1 dengan mengecualikan .env agar konfigurasi lokal aman
          rsync -av --delete \
            --exclude='.env' \
            --exclude='.git' \
            --exclude='.github' \
            ./ "$APP_DIR/"

      - name: Build & Launch Docker Container In-Place
        working-directory: /opt/web1
        run: |
          echo ">>> Menjalankan build Docker image lokal (tanpa GHCR)..."
          # Build ulang image secara lokal lalu reload kontainer tanpa downtime lama
          docker compose build --pull
          docker compose up -d --remove-orphans

      - name: Application Health Check
        run: |
          echo ">>> Menunggu service stabil dan melakukan health check..."
          sleep 5
          # Verifikasi apakah aplikasi merespons HTTP request di port internal
          curl -fsS --retry 5 --retry-delay 3 http://127.0.0.1:$APP_PORT/ || {
            echo "❌ Health check gagal! Service tidak merespons di port $APP_PORT."
            docker compose -f "$APP_DIR/docker-compose.yml" logs --tail=50
            exit 1
          }
          echo "✅ Health check berhasil! Aplikasi berjalan normal di port $APP_PORT."

      - name: Post-Deployment Storage Hygiene
        if: always()
        run: |
          echo ">>> Membersihkan sisa build cache dan dangling images..."
          # Menghapus image sisa (<none>:<none>) untuk menjaga kapasitas disk LXC
          docker image prune -f
```

---

### 10.6 Runbook Storage Hygiene & Mitigasi Kendala CI/CD In-LXC

| Kendala / Error | Gejala & Indikasi | Solusi & Tindakan Perbaikan |
|---|---|---|
| **No Space Left on Device** | Build Docker gagal dengan pesan `no space left on device` saat kompilasi layer. | 1. Di dalam LXC, periksa sisa disk: `df -h`.<br>2. Hapus build cache lama: `docker builder prune -a -f --filter "until=48h"`.<br>3. Bersihkan container stop: `docker container prune -f`.<br>4. Tambah kapasitas disk via Proxmox Host: `pct resize <ID> rootfs +10G`. |
| **Permission Denied Docker Socket** | Runner gagal menjalankan docker: `Got permission denied while trying to connect to Docker daemon socket`. | User `runner` belum terdaftar di grup `docker`. Jalankan di shell LXC: `usermod -aG docker runner`, lalu restart service runner: `systemctl restart actions.runner.*`. |
| **Runner Offline di GitHub** | Job GitHub Actions pending dengan status `Waiting for a runner to pick up this job`. | 1. Masuk ke shell LXC target.<br>2. Cek status daemon: `cd /home/runner/actions-runner && ./svc.sh status`.<br>3. Jika stop/mati: jalankan `./svc.sh start` atau periksa koneksi internet LXC (`curl -I https://github.com`). |
| **Health Check Timeout (Port Gagal)** | Workflow gagal di step `Application Health Check`. | 1. Periksa log container aplikasi: `docker compose -f /opt/<nama-app>/docker-compose.yml logs --tail=100`.<br>2. Pastikan service di dalam container mendengarkan pada `0.0.0.0`, bukan hanya `127.0.0.1` di dalam container.<br>3. Pastikan port binding di `docker-compose.yml` sudah benar (contoh `ports: - "3000:3000"`). |
| **File `.env` Terhapus / Timpa** | Variabel rahasia hilang setelah push git baru. | Pastikan perintah `rsync` selalu menyertakan opsi `--exclude='.env'`. Lakukan backup berkala file `/opt/<app>/.env`. |

---

## 11. Inventaris Layanan Terencana (Service Directory)

Tabel ini wajib diperbarui setiap kali rute baru diaktifkan di Ingress Gateway:

| Hostname Publik | Target Service (LXC/VM & IP) | Port Internal | Protokol | File Dynamic Config | Status | Keterangan |
|---|---|---|---|---|---|---|
| *(Contoh) app.domainmamay.com* | *LXC 101 - 192.168.0.101* | *3000* | *HTTP* | `/opt/ingress/dynamic/app.yml` | *Rencana / Template* | Aplikasi Frontend Web |
| *(Contoh) api.domainmamay.com* | *LXC 102 - 192.168.0.102* | *8080* | *HTTP* | `/opt/ingress/dynamic/api.yml` | *Rencana / Template* | Backend REST API |
| *(Contoh) auth.domainmamay.com* | *LXC 103 - 192.168.0.103* | *9000* | *HTTP* | `/opt/ingress/dynamic/auth.yml` | *Rencana / Template* | Layanan Autentikasi |
| *(Contoh) pve.domainmamay.com* | *Host PVE - 192.168.0.80* | *8006* | *HTTPS*| `/opt/ingress/dynamic/pve.yml`  | *Rencana / Template* | Proxmox VE Web UI |

---

## 12. Prosedur Pemeliharaan, Backup, & Pemulihan (Disaster Recovery)

### 12.1 Prosedur Backup Rutin
Direktori `/opt/ingress` adalah satu-satunya state penting di LXC 10080. Lakukan backup berkala ke penyimpanan sekunder:
```bash
# Membuat arsip backup tarball
tar -czvf /root/ingress-backup-$(date +%F).tar.gz -C /opt ingress

# Simpan salinan di luar node PVE (misal via SCP atau NAS)
```

### 12.2 Prosedur Pembaruan Container Stack
```bash
cd /opt/ingress
docker compose pull
docker compose up -d --remove-orphans
```

### 12.3 Prosedur Pemulihan Total (Full Recovery)
Jika LXC 10080 rusak total dan harus dibuat ulang:
1. Buat LXC 10080 baru di Proxmox sesuai spesifikasi Bagian 3.
2. Pasang Docker Engine sesuai Bagian 8 (Langkah 1).
3. Buat network `docker network create web-gateway`.
4. Restore folder `/opt/ingress` dari arsip backup.
5. Jalankan `docker compose up -d`. Tunnel Cloudflare akan langsung tersambung kembali secara otomatis karena konfigurasi remote disimpan di cloud Cloudflare.

---

## 13. Runbook Diagnostik & Troubleshooting Komprehensif

Jika terjadi gangguan akses (502 Bad Gateway, 1033 Tunnel Down, atau 404 Not Found), lakukan investigasi bertahap berikut:

### 13.1 Diagram Alur Diagnostik
```text
[ Insiden Akses Dilaporkan ]
             │
             ▼
[ 1. Cek Status Tunnel Cloudflare ] ──► (DOWN) ──► Cek container cloudflared & token
             │ (HEALTHY)
             ▼
[ 2. Uji Internal: cloudflared -> traefik:80 ] ──► (FAIL) ──► Cek network web-gateway
             │ (PASS)
             ▼
[ 3. Uji Reachability: LXC 10080 -> Backend IP ] ──► (FAIL) ──► Cek firewall & status LXC target
             │ (PASS)
             ▼
[ 4. Cek Traefik Dynamic Router & Log ] ──► (ERROR) ──► Perbaiki sintaks YAML / Host header
```

### 13.2 Perintah Uji Diagnostik (Best Practice)

#### 1. Uji Status Container Stack
```bash
cd /opt/ingress
docker compose ps
docker compose logs --tail=50 cloudflared
docker compose logs --tail=50 traefik
```

#### 2. Uji Konektivitas Docker Network Internal (`web-gateway`)
Karena image `cloudflared` berbasis distroless dan tidak memiliki binary `ping` atau shell interaktif lengkap, gunakan container curl diagnostik ephemeral:
```bash
docker run --rm --network web-gateway curlimages/curl:latest -sI http://traefik:80/
```
*Hasil Normal:* Mengembalikan header HTTP (misal: `HTTP/1.1 404 Not Found` langsung dari Traefik). Ini membuktikan koneksi TCP port 80 Traefik berfungsi di dalam network bridge.

#### 3. Uji Jangkauan ke IP Backend Homelab
Jalankan langsung dari shell LXC 10080:
```bash
curl -I http://192.168.0.X:PORT
```

#### 4. Validasi Format Sintaks YAML Dynamic Provider
```bash
# Memeriksa apakah ada karakter TAB atau kesalahan parsing pada file konfigurasi
docker compose logs traefik | grep -i "error"
```

### 13.3 Matriks Solusi Kendala (Troubleshooting Matrix)

| Gejala Masalah | Indikasi / Pesan Error | Akar Masalah | Solusi Cepat |
|---|---|---|---|
| **Cloudflare Error 1033** | *Cloudflare Tunnel error 1033: Argo Tunnel error* | Container `cloudflared` tidak berjalan, atau `TUNNEL_TOKEN` salah/kadaluarsa. | Jalankan `docker compose up -d cloudflared`. Periksa log dengan `docker compose logs cloudflared`. Verifikasi token di `.env`. |
| **Cloudflare Error 502** | *Bad Gateway (Cloudflare Edge)* | `cloudflared` tidak dapat menjangkau `traefik:80`. | 1. Pastikan container `traefik` running.<br>2. Pastikan kedua container tergabung dalam network `web-gateway`.<br>3. Uji dengan container curl ephemeral (Bagian 13.2 poin 2). |
| **Traefik 404 Not Found** | *404 page not found (Plain text)* | Host header tidak cocok dengan rule di dynamic config, atau file YAML belum terbaca. | 1. Cek Traefik Dashboard `:8080/dashboard/` menu HTTP Routers.<br>2. Pastikan `Host(...)` sama persis dengan domain yang diakses.<br>3. Pastikan ekstensi file adalah `.yml` atau `.yaml`. |
| **Traefik 502 Bad Gateway**| *Bad Gateway (Traefik)* | Traefik tidak dapat menjangkau IP atau Port backend LXC target. | 1. Uji `curl -I http://192.168.0.X:PORT` dari LXC 10080.<br>2. Pastikan service di LXC target listen di `0.0.0.0`, bukan `127.0.0.1`.<br>3. Periksa firewall LXC backend (`ufw status` atau PVE firewall). |
| **Traefik 504 Gateway Timeout**| *Gateway Timeout* | Backend menerima koneksi tetapi tidak merespons dalam batas waktu timeout. | Periksa beban CPU/RAM pada LXC backend target, koneksi database backend, atau timeout limit aplikasi. |
| **Docker Compose Error** | *network web-gateway declared as external, but could not be found* | Network eksternal belum dibuat sebelum menjalankan stack. | Jalankan perintah: `docker network create web-gateway`, lalu ulangi `docker compose up -d`. |
| **Dynamic Config Tidak Berubah** | Perubahan di YAML tidak muncul di dashboard | Inotify kernel event tidak terpicu, atau sintaks YAML rusak. | 1. Edit file langsung di dalam shell LXC 10080.<br>2. Cek `docker compose logs traefik` untuk melihat error parsing YAML.<br>3. Pastikan tidak ada tab (`\t`) dan nama router unik. |

---

## 14. Version & Change Ledger

Catat setiap perubahan konfigurasi arsitektur, upgrade software, atau perombakan rute pada tabel resmi ini:

| Tanggal | Versi | Rincian Perubahan / Tindakan | Otorisasi / Pelaksana |
|---|---|---|---|
| 2026-10-26 | `v1.0` | **Inisialisasi Baseline SSOT:** Rekonsiliasi draf awal arsitektur Ingress Gateway. | Mamay & AI Assistant |
| 2026-10-27 | `v1.1` | **Production Baseline Final (DevOps Edition):**<br>- Verifikasi resmi IP `192.168.0.80/24` & gateway `192.168.0.1`.<br>- PVE host spec (`nesting=1,keyctl=1`) & CLI provisioning guide.<br>- Prasyarat pembuatan `docker network create web-gateway`.<br>- Standar uji koneksi ephemeral container curl.<br>- SOP lengkap penambahan rute, runbook diagnostik, dan disaster recovery. | Mamay & DevOps Team |
| 2026-10-27 | `v1.2` | **Penambahan Modul CI/CD In-LXC (Zero GHCR Overhead):**<br>- Standarisasi alur CI/CD mandiri langsung di LXC target aplikasi (misal web1 LXC 100, web2 LXC 101).<br>- Runbook setup GitHub Actions Self-Hosted Runner berorientasi systemd daemon.<br>- Tata kelola keamanan file `.env` statis di host LXC (`/opt/<nama-app>/.env`).<br>- Template workflow `.github/workflows/deploy.yml` lengkap dengan health check & disk storage hygiene (`docker image prune`).<br>- Mitigasi kendala storage build cache & permission socket Docker. | Mamay & DevOps Team |
