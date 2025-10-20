import {
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeWASocket,
    useMultiFileAuthState,
    // Import proto sebagai value
    proto,
    getDevice,
} from '@whiskeysockets/baileys';
import type {
    WAMessage,
    AnyMessageContent, // Tipe umum untuk konten pesan
    AuthenticationCreds,
    BaileysEventMap,
    Chat,
    ConnectionState,
} from '@whiskeysockets/baileys';
import * as dotenv from 'dotenv';
import mqtt, { type MqttClient } from 'mqtt';
import pino from 'pino';
import qrcode from 'qrcode-terminal'; // Pastikan ini diimport
import fs from 'fs';
// Meta Cloud API removed per user request; use plain-text menus only

// Lokal: definisi sederhana untuk Button agar TypeScript mengenali tipe ini.
interface Button {
    buttonId: string;
    buttonText: { displayText: string };
    type?: number;
}

// 1. Load Konfigurasi (Sama)
dotenv.config();
const config = {
    mqttUrl: process.env.MQTT_URL || '',
    mqttUsername: process.env.MQTT_USERNAME,
    mqttPassword: process.env.MQTT_PASSWORD,
    topicLampu1: process.env.MQTT_TOPIC_LAMPU1 || 'smarthome/lampu1/perintah',
    topicLampu2: process.env.MQTT_TOPIC_LAMPU2 || 'smarthome/lampu2/perintah',
    topicStopkontak1: process.env.MQTT_TOPIC_STOPKONTAK1 || 'smarthome/stopkontak1/perintah',
    topicStopkontak2: process.env.MQTT_TOPIC_STOPKONTAK2 || 'smarthome/stopkontak2/perintah',
    passPhrase: process.env.PASS_PHRASE || '1234',
};
if (!config.mqttUrl) { console.error("Kesalahan: MQTT_URL belum diatur di file .env"); process.exit(1); }

// 2. Setup Logger (Sama)
const logger = pino({ level: 'silent' });
// Enable debug output for appLogger so we can see payloads during testing
const appLogger = pino({ level: 'debug', transport: { target: 'pino-pretty' } });

// 3. Variabel Global (Sama)
let mqttClient: MqttClient | null = null;
let waSocket: ReturnType<typeof makeWASocket> | null = null;
const authFolder = './auth_info_baileys';
// Connection flag & send queue
let isConnected = false;
const sendQueue: Array<() => Promise<void>> = [];
// Per-user conversational state (simple in-memory session)
const userStates: Map<string, { expecting?: string; tempDevice?: string; mode?: string }> = new Map();

async function flushQueue() {
    while (sendQueue.length) {
        const fn = sendQueue.shift();
        if (!fn) continue;
        try { await fn(); } catch (e) { appLogger.error(`Gagal flush queued message: ${e}`); }
    }
}

function enqueueSend(fn: () => Promise<void>) {
    if (isConnected) return fn();
    sendQueue.push(fn);
    appLogger.info('Pesan diantre sampai koneksi WhatsApp siap.');
    return Promise.resolve();
}

async function writeLastPayload(name: string, payload: any) {
    try {
        await fs.promises.mkdir(authFolder, { recursive: true });
        await fs.promises.writeFile(`${authFolder}/last_payload_${name}.json`, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) { appLogger.debug('Gagal tulis last payload'); }
}

// 4. Fungsi Koneksi MQTT (Sama)
function connectToMQTT() {
    if (mqttClient && mqttClient.connected) return;
    appLogger.info(`Mencoba terhubung ke MQTT Broker: ${config.mqttUrl}`);
    const options: mqtt.IClientOptions = { username: config.mqttUsername, password: config.mqttPassword, reconnectPeriod: 5000, connectTimeout: 10000 };
    if (!options.username) delete options.username;
    if (!options.password) delete options.password;
    mqttClient = mqtt.connect(config.mqttUrl, options);
    mqttClient.on('connect', () => { appLogger.info('✅ Terhubung ke MQTT Broker'); });
    mqttClient.on('error', (err) => { appLogger.error(`Kesalahan MQTT: ${err.message}`); });
    mqttClient.on('reconnect', () => { appLogger.warn('Mencoba terhubung ulang ke MQTT...'); });
    mqttClient.on('close', () => { if (mqttClient && !mqttClient.disconnecting) appLogger.warn('Koneksi MQTT terputus. Mencoba reconnect otomatis...'); else appLogger.info('Koneksi MQTT ditutup.'); });
}

// 5. Fungsi Publish MQTT (Sama)
function publishMQTT(topic: string, message: string, jid?: string) {
    if (mqttClient && mqttClient.connected) {
        appLogger.info(`[MQTT PUBLISH] Topic: ${topic}, Pesan: ${message}`);
        mqttClient.publish(topic, message, { qos: 1 }, (err) => {
            if (err) { appLogger.error(`Gagal publish MQTT ke topic ${topic}: ${err}`); if (jid) replyMessage(jid, `❌ Gagal mengirim perintah ke ${topic}.`); }
        });
    } else { appLogger.warn('MQTT tidak terhubung. Perintah gagal dikirim.'); if (jid) replyMessage(jid, "⚠️ Gagal mengirim perintah: Tdk terhubung ke server IoT."); }
}

// Async wrapper to publish and await result
function publishMQTTAsync(topic: string, message: string, jid?: string): Promise<boolean> {
    return new Promise((resolve) => {
        if (mqttClient && mqttClient.connected) {
            mqttClient.publish(topic, message, { qos: 1 }, (err) => {
                if (err) {
                    appLogger.error(`Gagal publish MQTT ke topic ${topic}: ${err}`);
                    if (jid) replyMessage(jid, `❌ Gagal mengirim perintah ke ${topic}.`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        } else {
            appLogger.warn('MQTT tidak terhubung. Perintah gagal dikirim.');
            if (jid) replyMessage(jid, "⚠️ Gagal mengirim perintah: Tdk terhubung ke server IoT.");
            resolve(false);
        }
    });
}

// 6. Fungsi Balas Pesan WA (Helper) (Sama)
async function replyMessage(jid: string, text: string) {
    if (!waSocket) { appLogger.warn('WA Socket tdk aktif, gagal membalas.'); return; }
    try { await waSocket.sendMessage(jid, { text }); } catch (error) { appLogger.error(`Gagal kirim pesan teks ke ${jid}: ${error}`); }
}

// --- DIPERBAIKI V3: Fungsi Kirim Pesan dengan Tombol ---
// Menggunakan struktur yang lebih umum untuk sendMessage dengan tombol
async function sendButtonMessage(jid: string, text: string, buttons: Button[], footer?: string) {
    if (!waSocket) { appLogger.warn('WA Socket tdk aktif, gagal kirim tombol.'); return; }
    // User requested text-only mode: build a plain-text representation of the buttons
    await enqueueSend(async () => {
        try {
            let plain = `${text}\n\n`;
            buttons.forEach((btn, idx) => {
                plain += `${idx + 1}. ${btn.buttonText?.displayText}\n`;
            });
            plain += `\nTombol tdk tersedia. Silakan ketik nomor atau perintah manual. Contoh: \"${config.passPhrase} lampu1 on\"`;
            if (footer) plain += `\n\n${footer}`;
            await writeLastPayload('plain_buttons', { to: jid, text: plain });
            await waSocket!.sendMessage(jid, { text: plain });
            appLogger.info(`Mengirim fallback teks (plain buttons) ke ${jid}`);
        } catch (err) {
            appLogger.error(`Gagal kirim plain buttons ke ${jid}: ${err}`);
        }
    });
}

// Helper: buat kode singkat dari QR untuk masukan manual (6 digit)
function generateShortCode(qr: string) {
    let sum = 0;
    for (let i = 0; i < qr.length; i++) sum = (sum + qr.charCodeAt(i) * (i + 1)) >>> 0;
    const code = (sum % 900000) + 100000; // pastikan 6 digit
    return String(code);
}

// Helper: simpan QR ke file agar bisa disalin / dipakai ulang jika terminal sulit membaca
async function saveLastQR(qr: string) {
    try {
        await fs.promises.mkdir(authFolder, { recursive: true });
        await fs.promises.writeFile(`${authFolder}/last_qr.txt`, qr, 'utf8');
        appLogger.info(`QR code saved to ${authFolder}/last_qr.txt`);
    } catch (err) {
        appLogger.error(`Gagal menyimpan QR: ${err}`);
    }
}

// Helper: normalisasi teks masuk (hapus tanda baca agar deteksi perintah lebih fleksibel)
function normalizeTextForCommand(input?: string | null) {
    if (!input) return '';
    // ubah smart quotes dan sejenisnya, lalu hanya ambil huruf/angka/spasi
    return input.replace(/[“”„‟«»‘’'"`~!@#$%^&*()\[\]{}\-_=+\\|;:,<.>/?]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Robust extractor: cari teks dari berbagai bentuk pesan yang mungkin
function extractTextFromMessage(m: any): string | null {
    if (!m) return null;
    // Common direct fields
    if (typeof m.conversation === 'string' && m.conversation.trim()) return m.conversation;
    if (m.extendedTextMessage && typeof m.extendedTextMessage.text === 'string' && m.extendedTextMessage.text.trim()) return m.extendedTextMessage.text;
    if (m.buttonsResponseMessage && typeof m.buttonsResponseMessage.selectedDisplayText === 'string' && m.buttonsResponseMessage.selectedDisplayText.trim()) return m.buttonsResponseMessage.selectedDisplayText;
    if (m.listResponseMessage && m.listResponseMessage.singleSelectReply && typeof m.listResponseMessage.singleSelectReply.selectedDisplayText === 'string' && m.listResponseMessage.singleSelectReply.selectedDisplayText.trim()) return m.listResponseMessage.singleSelectReply.selectedDisplayText;
    if (m.templateButtonReplyMessage && typeof m.templateButtonReplyMessage.selectedDisplayText === 'string' && m.templateButtonReplyMessage.selectedDisplayText.trim()) return m.templateButtonReplyMessage.selectedDisplayText;
    // captions
    if (m.imageMessage && typeof m.imageMessage.caption === 'string' && m.imageMessage.caption.trim()) return m.imageMessage.caption;
    if (m.videoMessage && typeof m.videoMessage.caption === 'string' && m.videoMessage.caption.trim()) return m.videoMessage.caption;
    if (m.documentMessage && typeof m.documentMessage.caption === 'string' && m.documentMessage.caption.trim()) return m.documentMessage.caption;
    // voice note has no text

    // ephemeral or nested messages (recurse)
    if (m.ephemeralMessage && m.ephemeralMessage.message) {
        const t = extractTextFromMessage(m.ephemeralMessage.message);
        if (t) return t;
    }
    if (m.messageContextInfo && m.messageContextInfo.quotedMessage) {
        const t = extractTextFromMessage(m.messageContextInfo.quotedMessage);
        if (t) return t;
    }

    // Fallback: search first string field in the object (breadth-first)
    const queue: any[] = [m];
    while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object') continue;
        for (const k of Object.keys(cur)) {
            const v = cur[k];
            if (!v) continue;
            if (typeof v === 'string' && v.trim()) return v;
            if (typeof v === 'object') queue.push(v);
        }
    }

    return null;
}

// Helper: ambil JID sendiri dari waSocket.user dengan berbagai bentuk
function getOwnJid(): string {
    try {
        const u: any = (waSocket as any)?.user;
        if (!u) return '';
        if (typeof u === 'string') return u;
        if (u?.id) return String(u.id);
        if (u?.jid) return String(u.jid);
        if (u?.user) return String(u.user);
    } catch (e) {
        // ignore
    }
    return '';
}

function bareJid(jid?: string) {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0];
}

// 8. Fungsi Menu Utama — teks saja (no buttons/lists)
async function sendMainMenu(jid: string, name: string) {
    const plainMenu = `👋 Halo ${name}!\nSelamat datang di Bot Smart Home Skariga. Pilih mode interaksi:\n\n1. Chat Biasa\n2. Kontrol IoT\n\nKetik nomor (1/2) atau ketik \"menu\" lagi. Jika ingin kirim perintah cepat gunakan passphrase, contoh:\n\"${config.passPhrase} lampu1 on\"`;
    await enqueueSend(async () => {
        try {
            await writeLastPayload('main_menu_plain', { to: jid, text: plainMenu });
            await waSocket!.sendMessage(jid, { text: plainMenu });
            appLogger.info(`Mengirim main menu (plain text) ke ${jid}`);
        } catch (e) { appLogger.error(`Gagal kirim main menu ke ${jid}: ${e}`); }
    });
}

// Send a list message (many clients display this reliably)
async function sendListMenu(jid: string, description: string, buttonText: string, sections: Array<any>, footer?: string) {
    // Convert list sections into a plain text menu for text-only mode
    await enqueueSend(async () => {
        try {
            let plain = `${description}\n\n`;
            let idx = 1;
            for (const sec of sections) {
                if (sec.title) plain += `${sec.title}\n`;
                for (const row of (sec.rows || [])) {
                    plain += `${idx}. ${row.title} - ${row.description || ''}\n`;
                    idx++;
                }
                plain += '\n';
            }
            plain += `Ketik nomor pilihan atau gunakan passphrase, contoh: \"${config.passPhrase} lampu1 on\"`;
            if (footer) plain += `\n\n${footer}`;
            await writeLastPayload('list_plain', { to: jid, text: plain });
            await waSocket!.sendMessage(jid, { text: plain });
            appLogger.info(`Mengirim list menu (plain text) ke ${jid}`);
        } catch (err: any) {
            appLogger.error(`Gagal kirim list plain ke ${jid}: ${err}`);
        }
    });
}

// Force resend menu and log result (useful during debugging)
async function forceResendMenu(jid: string) {
    try {
        appLogger.info(`Memaksa kirim menu ke ${jid}`);
        await sendMainMenu(jid, 'Pengguna');
        appLogger.info(`forceResendMenu: sukses untuk ${jid}`);
    } catch (err: any) {
        appLogger.error(`forceResendMenu: gagal untuk ${jid}: ${err?.stack ?? err?.message ?? err}`);
    }
}

// 9. Fungsi Menu IoT (Gunakan tipe Button lokal)
async function sendIoTMenu(jid: string) {
    // Plain text IoT menu: show available commands and passphrase examples
    const plain = `Kontrol Perangkat IoT:\n\n1. Lampu 1 ON  -> ${config.passPhrase} lampu1 on\n2. Lampu 1 OFF -> ${config.passPhrase} lampu1 off\n3. Lampu 2 ON  -> ${config.passPhrase} lampu2 on\n4. Lampu 2 OFF -> ${config.passPhrase} lampu2 off\n5. Stop Kontak 1 ON  -> ${config.passPhrase} stopkontak1 on\n6. Stop Kontak 1 OFF -> ${config.passPhrase} stopkontak1 off\n7. Stop Kontak 2 ON  -> ${config.passPhrase} stopkontak2 on\n8. Stop Kontak 2 OFF -> ${config.passPhrase} stopkontak2 off\n\nKetik contoh: \"${config.passPhrase} lampu1 on\"`;
    await enqueueSend(async () => {
        try {
            await writeLastPayload('iot_menu_plain', { to: jid, text: plain });
            await waSocket!.sendMessage(jid, { text: plain });
            appLogger.info(`Mengirim IoT menu (plain text) ke ${jid}`);
        } catch (e) { appLogger.error(`Gagal kirim IoT menu plain ke ${jid}: ${e}`); }
    });
}

// 10. Logika Pemroses Pesan (Sama)
async function handleMessage(message: WAMessage) {
    const m = message.message;
    if (!m || !message.key.remoteJid) {
        appLogger.debug('[HANDLE MESSAGE] No message or no remoteJid, skipping');
        return;
    }
    // allow message yourself (fromMe true) if remoteJid equals own jid
    const ownJid = getOwnJid();
    if (message.key.fromMe && message.key.remoteJid !== ownJid && message.key.remoteJid !== `${ownJid}`) {
        appLogger.debug('[HANDLE MESSAGE] message is fromMe and not self-chat, skipping');
        return;
    }
    const jid = message.key.remoteJid;
    const senderName = message.pushName || 'Pengguna';
    const device = getDevice(message.key.id ?? 'unknown');
    if (jid === 'status@broadcast') return;
    const messageType = Object.keys(m)[0];
    let receivedText = ''; let selectedButtonId = '';
    appLogger.info(`[PESAN MASUK] Dari: ${senderName} (${jid}), Tipe: ${messageType}, Device: ${device}`);
    appLogger.debug(`[PESAN MASUK] message keys: ${Object.keys(m).join(', ')}`);

    // Robust text extraction for many payload shapes
    const rawText = extractTextFromMessage(m);
    if (rawText) {
        receivedText = normalizeTextForCommand(rawText);
    }

    // If button response detected, capture selectedButtonId specifically
    if (m.buttonsResponseMessage) {
        selectedButtonId = m.buttonsResponseMessage.selectedButtonId || '';
        if (!receivedText) receivedText = normalizeTextForCommand(m.buttonsResponseMessage.selectedDisplayText);
        appLogger.info(`[TOMBOL DITEKAN] ID: ${selectedButtonId}, Teks: "${receivedText}"`);
    }

    if (!receivedText && !selectedButtonId) {
        appLogger.debug('[PESAN MASUK] Tidak ada teks yang dapat diekstrak dari pesan ini, akan di-skip');
        return;
    }
    if (!receivedText && !selectedButtonId) return;

    if (selectedButtonId) {
        let topic = ''; let payload = ''; let responseText = `✅ Perintah "${receivedText}" terkirim!`;
        switch (selectedButtonId) {
            case 'id_chat_biasa': await replyMessage(jid, 'Mode Chat Biasa Aktif.\nKetik "menu" utk kembali.'); break;
            case 'id_menu_iot': await sendIoTMenu(jid); break;
            case 'iot_lampu1_on': topic = config.topicLampu1; payload = 'ON'; break;
            case 'iot_lampu1_off': topic = config.topicLampu1; payload = 'OFF'; break;
            case 'iot_lampu2_on': topic = config.topicLampu2; payload = 'ON'; break;
            case 'iot_lampu2_off': topic = config.topicLampu2; payload = 'OFF'; break;
            case 'iot_stopkontak1_on': topic = config.topicStopkontak1; payload = 'ON'; break;
            case 'iot_stopkontak1_off': topic = config.topicStopkontak1; payload = 'OFF'; break;
            case 'iot_stopkontak2_on': topic = config.topicStopkontak2; payload = 'ON'; break;
            case 'iot_stopkontak2_off': topic = config.topicStopkontak2; payload = 'OFF'; break;
            default: appLogger.warn(`Tombol dgn ID "${selectedButtonId}" tdk dikenal.`); responseText = `Maaf, tombol "${receivedText}" blm saya kenali.`; topic = ''; break;
        }
        if (topic && payload) { publishMQTT(topic, payload, jid); await replyMessage(jid, responseText); }
        else if (responseText && !['id_chat_biasa', 'id_menu_iot'].includes(selectedButtonId)) { await replyMessage(jid, responseText); }
    }
    else if (receivedText) {
        // numeric and menu-driven flows
        if (['menu', 'mulai', 'halo', 'hi', 'p'].includes(receivedText)) { await sendMainMenu(jid, senderName); }
        else if (receivedText === '1') {
            // Chat biasa
            await replyMessage(jid, 'Mode Chat Biasa Aktif. Ketik "menu" utk kembali.');
            userStates.set(jid, { expecting: undefined, mode: 'chat' });
        } else if (receivedText === '2') {
            // Kontrol IoT: require manual device commands only (no numeric selection)
            const devicesText = `Kontrol IoT - Mode Manual\nTolong ketik perintah lengkap: <device> <on|off>\nContoh: \"lampu1 on\" atau gunakan passphrase: \"${config.passPhrase} lampu1 on\"\nDaftar device: lampu1, lampu2, stopkontak1, stopkontak2\n\nPerintah tambahan: ketik \"kembali\" untuk lihat daftar device lagi, atau \"keluar\" untuk kembali ke menu utama.`;
            await replyMessage(jid, devicesText);
            userStates.set(jid, { expecting: 'iot_manual', mode: 'iot' });
        }
        else if (config.passPhrase && receivedText.startsWith(config.passPhrase)) {
            const parts = receivedText.substring(config.passPhrase.length).trim().split(' ');
            if (parts.length === 2) {
                const channelId = parts[0]; const action = parts[1].toUpperCase();
                let topic = ''; let payload = ''; let response = `Perintah passphrase diterima: "${channelId} ${action}".`;
                if (action === 'ON' || action === 'OFF') {
                    payload = action;
                    switch (channelId) {
                        case 'lampu1': topic = config.topicLampu1; break; case 'lampu2': topic = config.topicLampu2; break;
                        case 'stopkontak1': topic = config.topicStopkontak1; break; case 'stopkontak2': topic = config.topicStopkontak2; break;
                        default: response = `Channel "${channelId}" tdk dikenal. Tersedia: lampu1, lampu2, stopkontak1, stopkontak2.`; break;
                    }
                } else { response = `Aksi "${action}" tdk valid. Gunakan "on" atau "off".`; }
                if (topic && payload) {
                    appLogger.info(`[PASSPHRASE] Channel: ${channelId}, Aksi: ${payload}`);
                    const ok = await publishMQTTAsync(topic, payload, jid);
                    response = ok ? `✅ OK, perintah "${channelId} ${payload}" terkirim.` : `❌ Gagal kirim perintah "${channelId} ${payload}".`;
                }
                await replyMessage(jid, response);
            } else { await replyMessage(jid, 'Format passphrase salah. Contoh: "1234 lampu1 on"'); }
        }
        else {
            // Manual IoT flow: expect full device+action like 'lampu1 on'
            const userState = userStates.get(jid) || {};
            if (userState.expecting === 'iot_manual' && userState.mode === 'iot') {
                // Handle exit/back commands
                if (['kembali', 'list'].includes(receivedText)) {
                    const devicesText = `Daftar device:\n- lampu1\n- lampu2\n- stopkontak1\n- stopkontak2\n\nKetik perintah lengkap: \"lampu1 on\" atau \"${config.passPhrase} lampu1 on\"`;
                    await replyMessage(jid, devicesText);
                    return;
                }
                if (['keluar', 'exit'].includes(receivedText)) {
                    await replyMessage(jid, 'Keluar dari mode Kontrol IoT. Kembali ke menu utama.');
                    userStates.delete(jid);
                    await sendMainMenu(jid, senderName);
                    return;
                }

                // Match device + action
                const m = receivedText.match(/^(lampu1|lampu2|stopkontak1|stopkontak2)\s+(on|off)$/i);
                if (m) {
                    const deviceId = m[1].toLowerCase();
                    const action = m[2].toUpperCase();
                    let topic = '';
                    switch (deviceId) {
                        case 'lampu1': topic = config.topicLampu1; break;
                        case 'lampu2': topic = config.topicLampu2; break;
                        case 'stopkontak1': topic = config.topicStopkontak1; break;
                        case 'stopkontak2': topic = config.topicStopkontak2; break;
                    }
                    if (topic) {
                        const ok = await publishMQTTAsync(topic, action, jid);
                        await replyMessage(jid, ok ? `✅ Perintah ${deviceId} ${action} terkirim.` : `❌ Gagal kirim perintah ke ${deviceId}.`);
                        // Remain in IoT manual mode but allow user to 'kembali' or 'keluar'
                        await replyMessage(jid, `Ketik perintah lain, atau ketik \"kembali\" untuk lihat daftar device, ketik \"keluar\" utk kembali ke menu.`);
                        return;
                    }
                }
                // If not matched, prompt correct format
                await replyMessage(jid, `Perintah tidak dikenali. Format yg valid: \"lampu1 on\" atau \"${config.passPhrase} lampu1 on\". Ketik \"kembali\" atau \"keluar\".`);
                return;
            }

            let response = `Hai ${senderName}! Pesan Anda "${receivedText}" diterima. Ketik "menu" utk opsi. 🤖`;
            if (receivedText === 'ping') { response = 'Pong! 🏓'; }
            else if (receivedText === 'status') { const waStatus = waSocket?.user ? 'Terhubung' : 'Terputus'; const mqttStatus = (mqttClient && mqttClient.connected) ? 'Terhubung' : 'Terputus'; response = `Status Koneksi:\n- WhatsApp: ${waStatus}\n- MQTT Broker: ${mqttStatus}`; }
            await replyMessage(jid, response);
        }
    }
}

// --- DIPERBAIKI V3: Fungsi Utama Koneksi WhatsApp (Manual QR Code + printQRInTerminal: false) ---
async function connectToWhatsApp() {
    appLogger.info('Mempersiapkan koneksi WhatsApp...');
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    appLogger.info(`Menggunakan Baileys v${version.join('.')}, Latest: ${isLatest}`);

    waSocket = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // <-- Set ke false karena kita handle manual
        logger,
        browser: ['WA-IoT-Bot', 'Chrome', '1.0.0'],
        shouldIgnoreJid: jid => jid === 'status@broadcast',
        getMessage: async key => ({ conversation: '' })
    });

    waSocket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            appLogger.info('QR Code diterima, silakan scan dgn WhatsApp di HP Anda:');
            // Tampilkan QR secara manual di terminal (jika terminal support)
            try { qrcode.generate(qr, { small: true }); } catch { /* ignore */ }
            // Simpan QR ke file guna akses di luar terminal
            void saveLastQR(qr);
            // Cetak kode singkat agar user bisa memasukkan kode manual atau verif cepat
            const shortCode = generateShortCode(qr);
            appLogger.info(`Short QR code: ${shortCode} (6 digit)`);
        }
        if (connection === 'open') {
            appLogger.info('✅ Terhubung ke WhatsApp!');
            // Log tambahan: siap dipakai untuk mengirim/terima pesan
            appLogger.info('Bot siap: dapat mengirim dan menerima pesan sekarang.');
            // set flag koneksi siap jika ada antrean pesan
            isConnected = true;
            // simpan ownJid ke file untuk referensi pengujian
            try {
                const own = getOwnJid();
                if (own) {
                    await fs.promises.writeFile(`${authFolder}/own_jid.txt`, own, 'utf8');
                    appLogger.info(`ownJid disimpan: ${own}`);
                }
                    // force resend menu to ownJid for debugging (one-time)
                    try { void forceResendMenu(own); } catch { /* ignore */ }
            } catch (e) { appLogger.debug('Gagal simpan ownJid ke file'); }
            // flush any queued outgoing messages
            void flushQueue();
        }
        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            appLogger.warn(`Koneksi WhatsApp terputus: ${lastDisconnect?.error || 'Alasan tdk diketahui'}. Kode: ${statusCode}. Reconnect: ${shouldReconnect}`);
            if (shouldReconnect) { appLogger.info('Mencoba reconnect WhatsApp dlm 10 detik...'); setTimeout(connectToWhatsApp, 10000); }
            else { appLogger.error('Logged out. Hapus folder auth_info_baileys & restart aplikasi utk scan QR baru.'); }
        }
    });
    waSocket.ev.on('creds.update', saveCreds);
    waSocket.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                const remoteJid = msg.key.remoteJid || '';
                const fromMe = !!msg.key.fromMe;
                const selfId = waSocket?.user?.id || (waSocket as any)?.user?.jid || '';
                // treat as incoming if message not from me, or it's a "message yourself" (remoteJid === selfId)
                const treatAsIncoming = !fromMe || (fromMe && remoteJid === selfId);

                if (treatAsIncoming && msg.message) {
                    // Kirim presence composing sebentar agar terlihat aktif (mengurangi kesan delay)
                    try {
                        await waSocket?.presenceSubscribe(remoteJid);
                        await waSocket?.sendPresenceUpdate('composing', remoteJid);
                        // jeda kecil lalu set paused
                        setTimeout(() => { void waSocket?.sendPresenceUpdate('paused', remoteJid); }, 700);
                    } catch (e) {
                        appLogger.debug('Gagal kirim presence (opsional)');
                    }
                    // Tangani pesan (gunakan handleMessage yang sudah menormalkan teks di dalamnya)
                    await handleMessage(msg);
                } else {
                    appLogger.debug(`[SKIP PESAN] fromMe=${fromMe}, remote=${remoteJid}, selfId=${selfId}`);
                }
            }
        }
    });
    return waSocket;
}

// 12. Fungsi Utama Aplikasi (Sama)
async function main() {
    appLogger.info('--- Memulai Bot WA IoT (Sesuai ESP32 - Perbaikan Tipe V3) ---'); // Update nama log
    try { connectToMQTT(); await connectToWhatsApp(); } catch (error) { appLogger.fatal(`Gagal memulai bot: ${error}`); process.exit(1); }
}
main();

// Tangani SIGINT (Ctrl+C) (Sama)
process.on('SIGINT', async () => {
    appLogger.info("Menutup koneksi...");
    if (waSocket) { waSocket.end(undefined); appLogger.info("Koneksi WhatsApp ditutup."); }
    if (mqttClient) { mqttClient.end(true, () => { appLogger.info("Koneksi MQTT ditutup."); process.exit(0); }); }
    else { process.exit(0); }
    setTimeout(() => { appLogger.warn("Penutupan paksa stlh timeout."); process.exit(1); }, 3000);
});