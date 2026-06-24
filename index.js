/**
 * EduQuiz WhatsApp Bot
 *
 * This logs into a real WhatsApp account (like WhatsApp Web - you scan a QR
 * code once with your phone) and stays connected. It exposes a small HTTP
 * API so PHP can ask it to send messages, the same way PHP already talks to
 * the Python extraction service.
 *
 * SETUP (first time, and again any time the login is lost):
 *   1. Start this service (locally with `npm start`, or watch its logs on Render).
 *   2. Open this service's web address + "/qr" in a browser, e.g.:
 *        http://localhost:3000/qr
 *   3. Open WhatsApp on your phone -> Settings -> Linked Devices -> Link a Device
 *      -> scan the QR code shown on that page.
 *   4. Once linked, /qr will say "Already connected" and /send will start working.
 *
 * ENDPOINTS
 *   GET  /health         -> { status: "ok", connected: true/false }
 *   GET  /qr              -> shows the QR code to scan (or "already connected")
 *   POST /send             -> { phone, message } -> sends a real WhatsApp message
 *        Requires header: X-API-Key: <WHATSAPP_BOT_API_KEY>
 */

const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.WHATSAPP_BOT_API_KEY || '';
const AUTH_FOLDER = './auth_session';

let sock = null;
let latestQrDataUrl = null;
let isConnected = false;

const logger = pino({ level: 'silent' }); // keep Render logs clean; set to 'info' to debug

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
  });

  sock.ev.on('creds.update', saveCreds);

  // Track delivery status of messages we send: PENDING(0) -> SERVER_ACK(1,
  // accepted by WhatsApp's servers) -> DELIVERY_ACK(2, reached the phone) ->
  // READ(3, opened). This is the real proof of what happened after "sent".
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      console.log(`[whatsapp-bot] Message ${u.key?.id} status update:`, u.update?.status);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrDataUrl = await qrcode.toDataURL(qr);
      isConnected = false;
    }

    if (connection === 'open') {
      isConnected = true;
      latestQrDataUrl = null;
      console.log('[whatsapp-bot] Connected to WhatsApp.');
    }

    if (connection === 'close') {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log(`[whatsapp-bot] Connection closed (loggedOut=${loggedOut}). Reconnecting...`);
      if (!loggedOut) {
        startSock(); // auto-reconnect unless the session was explicitly logged out
      } else {
        console.log('[whatsapp-bot] Logged out - delete the auth_session folder and rescan the QR code.');
      }
    }
  });
}

startSock().catch((err) => {
  console.error('[whatsapp-bot] Failed to start:', err);
});

// ── HTTP API ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isConnected });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send('<h2>Already connected to WhatsApp.</h2><p>No QR code needed.</p>');
  }
  if (!latestQrDataUrl) {
    return res.send('<h2>Starting up, please refresh in a few seconds...</h2>');
  }
  res.send(`
    <h2>Scan this with WhatsApp (Linked Devices)</h2>
    <img src="${latestQrDataUrl}" style="width:300px;height:300px" />
    <p>This page refreshes every 10 seconds until you scan it.</p>
    <script>setTimeout(() => location.reload(), 10000)</script>
  `);
});

app.post('/send', async (req, res) => {
  const providedKey = req.header('X-API-Key') || '';
  if (!API_KEY || providedKey !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
  }

  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected. Visit /qr to (re)link.' });
  }

  const { phone, message } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Missing phone or message' });
  }

  try {
    // Convert "+201555822948" or "01555822948" into the jid format Baileys needs
    let digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = '20' + digits.slice(1); // assume Egypt if a local-format number slips through
    const jid = `${digits}@s.whatsapp.net`;

    // Ask WhatsApp directly whether this number actually has an account,
    // BEFORE attempting to send. This is the real proof - sendMessage()
    // succeeding does NOT mean the number is valid.
    const [check] = await sock.onWhatsApp(jid);
    console.log(`[whatsapp-bot] onWhatsApp check for ${phone}:`, check);
    if (!check || !check.exists) {
      return res.status(404).json({
        success: false,
        error: `Number ${phone} does not appear to have an active WhatsApp account (per WhatsApp's own servers).`,
      });
    }

    const sent = await sock.sendMessage(check.jid, { text: message });
    console.log(`[whatsapp-bot] Sent. Message key:`, sent?.key);
    res.json({ success: true, messageId: sent?.key?.id || null });
  } catch (err) {
    console.error('[whatsapp-bot] Send failed:', err);
    res.status(500).json({ success: false, error: err.message || 'Unknown error' });
  }
});

app.listen(PORT, () => {
  console.log(`[whatsapp-bot] HTTP server listening on port ${PORT}`);
});