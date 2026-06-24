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
 *   GET  /status         -> detailed connection status
 *   GET  /qr             -> shows the QR code to scan (or "already connected")
 *   POST /send           -> { phone, message } -> sends a real WhatsApp message
 *        Requires header: X-API-Key: <WHATSAPP_BOT_API_KEY>
 */

const express = require('express');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
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
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Use 'info' level for debugging, 'silent' for production
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

async function startSock() {
  console.log('[whatsapp-bot] 🚀 Starting WhatsApp bot...');
  console.log('[whatsapp-bot] Auth folder:', AUTH_FOLDER);
  console.log('[whatsapp-bot] Auth folder exists:', fs.existsSync(AUTH_FOLDER));
  
  if (fs.existsSync(AUTH_FOLDER)) {
    const files = fs.readdirSync(AUTH_FOLDER);
    console.log('[whatsapp-bot] Session files:', files);
  }

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    console.log('[whatsapp-bot] Baileys version:', version);

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: true, // This will print QR in logs for debugging
    });

    sock.ev.on('creds.update', saveCreds);

    // Track delivery status of messages we send
    sock.ev.on('messages.update', (updates) => {
      for (const u of updates) {
        console.log(`[whatsapp-bot] Message ${u.key?.id} status update:`, u.update?.status);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      // Detailed connection logging
      console.log('[whatsapp-bot] 📡 Connection update:', {
        connection: update.connection,
        hasQR: !!update.qr,
        hasLastDisconnect: !!update.lastDisconnect,
        statusCode: update.lastDisconnect?.error?.output?.statusCode,
        errorMessage: update.lastDisconnect?.error?.message?.substring(0, 100)
      });

      const { connection, lastDisconnect, qr } = update;

      // Handle QR Code
      if (qr) {
        console.log('[whatsapp-bot] 📱 QR Code received');
        try {
          latestQrDataUrl = await qrcode.toDataURL(qr);
          isConnected = false;
          console.log('[whatsapp-bot] ✅ QR code converted to data URL');
        } catch (qrError) {
          console.error('[whatsapp-bot] ❌ Failed to generate QR code:', qrError);
        }
      }

      // Handle Connection Open
      if (connection === 'open') {
        isConnected = true;
        latestQrDataUrl = null;
        reconnectAttempts = 0;
        console.log('[whatsapp-bot] ✅✅✅ CONNECTED TO WHATSAPP ✅✅✅');
        console.log('[whatsapp-bot] Ready to send messages');
        
        // Log device info
        try {
          const creds = sock.authState.creds;
          console.log('[whatsapp-bot] Device:', {
            me: creds.me ? 'registered' : 'unknown',
            platform: creds.platform || 'unknown'
          });
        } catch (e) {
          console.log('[whatsapp-bot] Could not get device info');
        }
      }

      // Handle Connection Close
      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        
        console.log(`[whatsapp-bot] ❌ Connection closed`);
        console.log(`[whatsapp-bot] Status code: ${statusCode}, Logged out: ${loggedOut}`);
        console.log(`[whatsapp-bot] Reconnect attempts: ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

        // Check session files
        if (fs.existsSync(AUTH_FOLDER)) {
          const files = fs.readdirSync(AUTH_FOLDER);
          console.log('[whatsapp-bot] Session files present:', files);
        } else {
          console.log('[whatsapp-bot] ⚠️ No session folder found');
        }

        if (!loggedOut && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          console.log(`[whatsapp-bot] 🔄 Reconnecting in 5 seconds... (Attempt ${reconnectAttempts})`);
          setTimeout(() => {
            if (!isConnected) {
              console.log('[whatsapp-bot] 🔄 Attempting reconnection...');
              startSock().catch(err => {
                console.error('[whatsapp-bot] Reconnection failed:', err);
              });
            }
          }, 5000);
        } else if (loggedOut) {
          console.log('[whatsapp-bot] 🚫 Logged out - delete auth_session folder and rescan QR');
          // Reset QR state to force new QR
          latestQrDataUrl = null;
        } else {
          console.log('[whatsapp-bot] ⛔ Max reconnection attempts reached. Please restart the service.');
        }
      }
    });

    console.log('[whatsapp-bot] ✅ WhatsApp socket initialized');
    return sock;

  } catch (error) {
    console.error('[whatsapp-bot] ❌ Failed to start WhatsApp socket:', error);
    throw error;
  }
}

// Start the bot with error handling
startSock().catch((err) => {
  console.error('[whatsapp-bot] Fatal error starting bot:', err);
});

// ── HTTP API ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

// Detailed status endpoint
app.get('/status', (req, res) => {
  const hasAuthFolder = fs.existsSync(AUTH_FOLDER);
  let sessionFiles = [];
  if (hasAuthFolder) {
    sessionFiles = fs.readdirSync(AUTH_FOLDER);
  }

  res.json({
    connected: isConnected,
    state: isConnected ? 'connected' : (latestQrDataUrl ? 'waiting_qr' : 'connecting'),
    hasSocket: !!sock,
    hasQr: !!latestQrDataUrl,
    authFolderExists: hasAuthFolder,
    sessionFiles: sessionFiles,
    reconnectAttempts: reconnectAttempts,
    maxReconnectAttempts: MAX_RECONNECT_ATTEMPTS,
    timestamp: new Date().toISOString()
  });
});

// QR Code endpoint
app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.send(`
      <h2>✅ Already connected to WhatsApp</h2>
      <p>Bot is ready to send messages.</p>
      <p><a href="/status">Check detailed status</a></p>
    `);
  }
  
  if (!latestQrDataUrl) {
    return res.send(`
      <h2>⏳ Starting up...</h2>
      <p>Waiting for QR code. Please refresh in a few seconds.</p>
      <p>If this persists, check the server logs.</p>
      <script>setTimeout(() => location.reload(), 5000)</script>
    `);
  }
  
  res.send(`
    <h2>📱 Scan with WhatsApp</h2>
    <p>Open WhatsApp → Settings → Linked Devices → Link a Device</p>
    <img src="${latestQrDataUrl}" style="width:300px;height:300px;border:2px solid #25D366;border-radius:10px;" />
    <p>⏳ This page refreshes every 10 seconds until you scan it.</p>
    <p>📊 <a href="/status">Check connection status</a></p>
    <script>setTimeout(() => location.reload(), 10000)</script>
  `);
});

// Send message endpoint
app.post('/send', async (req, res) => {
  const providedKey = req.header('X-API-Key') || '';
  
  if (!API_KEY || providedKey !== API_KEY) {
    console.log('[whatsapp-bot] ❌ Invalid API key attempt');
    return res.status(401).json({ 
      success: false, 
      error: 'Invalid or missing API key' 
    });
  }

  if (!isConnected || !sock) {
    console.log('[whatsapp-bot] ❌ Not connected to WhatsApp');
    return res.status(503).json({ 
      success: false, 
      error: 'WhatsApp not connected. Visit /qr to link the device.',
      connected: isConnected,
      hasSocket: !!sock
    });
  }

  const { phone, message } = req.body || {};
  
  if (!phone || !message) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing phone or message' 
    });
  }

  try {
    console.log(`[whatsapp-bot] 📤 Attempting to send message to ${phone}`);
    
    // Clean phone number
    let digits = String(phone).replace(/[^0-9]/g, '');
    if (digits.startsWith('0')) digits = '20' + digits.slice(1); // Egypt default
    const jid = `${digits}@s.whatsapp.net`;

    // Verify number exists on WhatsApp
    console.log(`[whatsapp-bot] 🔍 Checking if ${phone} is on WhatsApp...`);
    const [check] = await sock.onWhatsApp(jid);
    console.log(`[whatsapp-bot] onWhatsApp result:`, check);

    if (!check || !check.exists) {
      return res.status(404).json({
        success: false,
        error: `Number ${phone} does not have an active WhatsApp account`,
        phone: phone,
        checked: check || null
      });
    }

    // Send the message
    console.log(`[whatsapp-bot] 📨 Sending message to ${check.jid}...`);
    const sent = await sock.sendMessage(check.jid, { text: message });
    
    console.log(`[whatsapp-bot] ✅ Message sent! ID:`, sent?.key?.id);
    res.json({ 
      success: true, 
      messageId: sent?.key?.id || null,
      phone: phone,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('[whatsapp-bot] ❌ Send failed:', err);
    res.status(500).json({ 
      success: false, 
      error: err.message || 'Unknown error sending message',
      details: err.stack
    });
  }
});

// Start the HTTP server
app.listen(PORT, () => {
  console.log(`[whatsapp-bot] 🌐 HTTP server listening on port ${PORT}`);
  console.log(`[whatsapp-bot] 📊 Status endpoint: http://localhost:${PORT}/status`);
  console.log(`[whatsapp-bot] 📱 QR endpoint: http://localhost:${PORT}/qr`);
  console.log(`[whatsapp-bot] 🔑 API Key set: ${API_KEY ? '✅ Yes' : '❌ No'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[whatsapp-bot] Received SIGTERM, shutting down gracefully...');
  if (sock) {
    sock.end(() => {
      console.log('[whatsapp-bot] Connection closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});