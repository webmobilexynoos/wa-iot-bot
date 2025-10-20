# Bot WhatsApp IoT (Node.js + MQTT + Menu Tombol)

Proyek ini adalah server Node.js/TypeScript yang berfungsi sebagai bot WhatsApp interaktif. Bot ini menyediakan menu tombol untuk memilih mode chat (biasa atau IoT) dan memberikan tombol perintah untuk mengendalikan perangkat IoT (seperti ESP32) melalui MQTT.

## Fitur

-   **Menu Interaktif:** Menggunakan tombol WhatsApp untuk navigasi yang mudah dan profesional.
-   **Dua Mode Utama:**
    -   **💬 Chat Biasa:** Membalas pesan umum.
    -   **💡 Kontrol IoT:** Menampilkan tombol perintah spesifik (Nyalakan/Matikan Lampu/Kipas).
-   **Integrasi MQTT:** Meneruskan perintah dari tombol IoT ke broker MQTT.
-   **Alternatif Passphrase:** Masih mendukung perintah teks dengan *passphrase* (misal: "1234 lampu on").
-   **Persistensi Sesi:** Menyimpan sesi WhatsApp (`auth_info_baileys`) agar tidak perlu scan QR berulang kali.
-   **Auto Reconnect:** Otomatis mencoba terhubung kembali jika koneksi WhatsApp atau MQTT terputus.
-   **Konfigurasi Mudah:** Pengaturan MQTT, Topics, dan Passphrase via file `.env`.

---

## Arsitektur

Sama seperti sebelumnya: Pengguna -> WA Bot (VPS 1) -> MQTT Broker (VPS 2) -> ESP32.

---

## Setup & Instalasi (VPS 1 - Node.js Server)

### 1. Persiapan Server

Pastikan VPS kamu (disarankan Ubuntu 22.04+) sudah terinstal:
-   **Node.js v18 atau lebih baru**
-   **NPM** (terinstal bersama Node.js)
-   **Git** (opsional, untuk clone repo)
-   **(Sangat Direkomendasikan) PM2** (`sudo npm install pm2 -g`) untuk menjalankan bot di background.

*(Lihat jawaban sebelumnya untuk detail perintah instalasi Node.js via NodeSource jika perlu)*

### 2. Dapatkan Kode Bot

1.  **Jika pakai Git:**
    ```bash
    git clone https://URL_REPO_ANDA.git wa-iot-bot-menu
    cd wa-iot-bot-menu
    ```
2.  **Jika upload manual:** Upload folder `wa-iot-bot-menu` ke VPS kamu, lalu masuk ke folder tersebut via SSH.

### 3. Instal Dependensi Proyek

Di dalam folder `wa-iot-bot-menu`, jalankan:
```bash
npm install
```
Ini akan mengunduh semua library yang dibutuhkan (Baileys, MQTT, dll.) ke folder `node_modules`.

### 4. Konfigurasi Lingkungan (.env)

1.  Salin file contoh `.env.example` menjadi `.env`:
    ```bash
    cp .env.example .env
    ```
2.  Edit file `.env` (misal: `nano .env`) dan **isi semua nilainya** sesuai konfigurasi kamu:
    -   `MQTT_URL`: Alamat broker MQTT di VPS kedua (contoh: `mqtt://192.168.1.100:1883`).
    -   `MQTT_USERNAME` & `MQTT_PASSWORD`: Jika broker kamu pakai autentikasi.
    -   `MQTT_TOPIC_LAMP`, `MQTT_TOPIC_FAN`: Pastikan **sama persis** dengan yang di-subscribe oleh ESP32.
    -   `PASS_PHRASE`: Kata sandi alternatif jika ingin pakai perintah teks.

### 5. Build Kode TypeScript

Compile kode `.ts` menjadi `.js` agar bisa dijalankan Node.js:
```bash
npm run build
```
Ini akan membuat folder `dist` berisi file `index.js`.

### 6. Menjalankan Bot & Scan QR

1.  **Jalankan bot untuk pertama kali:**
    ```bash
    npm start
    ```
    Atau jika ingin lihat log lebih detail saat development:
    ```bash
    npm run dev
    ```
2.  Terminal akan menampilkan **QR Code**.
3.  Buka WhatsApp di HP kamu (nomor yang jadi bot) -> Setelan -> Perangkat Tertaut -> Tautkan Perangkat.
4.  **Scan QR Code** yang muncul di terminal.
5.  Tunggu hingga muncul log `✅ Terhubung ke WhatsApp!`.
6.  Folder `auth_info_baileys` akan dibuat otomatis. **Jangan hapus folder ini!**
7.  Kamu bisa menghentikan bot sementara (Ctrl+C).

### 7. Menjalankan di Background dengan PM2 (Rekomendasi)

Agar bot tetap jalan setelah kamu tutup SSH:

```bash
# Start bot dengan nama 'wa-bot-menu'
pm2 start dist/index.js --name wa-bot-menu

# (Opsional) Simpan daftar proses PM2 agar otomatis start setelah reboot
pm2 save

# Melihat log bot
pm2 logs wa-bot-menu

# Menghentikan bot
pm2 stop wa-bot-menu

# Menghapus bot dari PM2
pm2 delete wa-bot-menu
```

---

## Setup ESP32

Gunakan kode ESP32 dari jawaban sebelumnya. Pastikan **topic MQTT** (`topicLamp`, `topicFan`) di kode ESP32 **sama persis** dengan `MQTT_TOPIC_LAMP` dan `MQTT_TOPIC_FAN` di file `.env` bot WhatsApp kamu.

---

## Cara Penggunaan Bot

1.  Kirim pesan apa saja ke nomor WA bot kamu (misal: "halo", "menu", "p").
2.  Bot akan membalas dengan tombol "💬 Chat Biasa" dan "💡 Kontrol IoT".
3.  Tekan "💡 Kontrol IoT".
4.  Bot akan mengirimkan tombol-tombol perintah (Nyalakan Lampu, Matikan Lampu, Nyalakan Kipas, Matikan Kipas).
5.  Tekan tombol perintah yang diinginkan.
6.  Bot akan mengirim konfirmasi dan meneruskan perintah ke MQTT -> ESP32.

**Alternatif:** Kamu juga bisa ketik langsung `[PASS_PHRASE] [perintah]`, contoh: `1234 lampu off`.