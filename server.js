const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ── STATS PERSISTENCE ──
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
    }
  } catch (e) { console.error('Error loading stats:', e.message); }
  return { messages: [] };
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) { console.error('Error saving stats:', e.message); }
}

let globalStats = loadStats();

function recordMessage(entry) {
  globalStats.messages.push(entry);
  saveStats(globalStats);
}

function updateMessageStatus(jid, gestor, field) {
  const msg = globalStats.messages.find(
    m => m.jid === jid && m.gestor === gestor && !m[field]
  );
  if (msg) {
    msg[field] = new Date().toISOString();
    saveStats(globalStats);
  }
}

// ── REST ENDPOINT: coordinator stats ──
app.get('/api/stats', (req, res) => {
  res.json(globalStats);
});

const PASSWORD = 'Interconsumo2026';
const activeSessions = {};
const logger = pino({ level: 'silent' });

async function startWhatsAppSession(socketId, username, moraType) {
  const sessionPath = path.join(SESSIONS_DIR, username);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  let version = [2, 3000, 1015901307];
  try {
    const latest = await Promise.race([
      fetchLatestBaileysVersion(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    version = latest.version;
  } catch (e) {
    console.log('Using fallback WA version');
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['InterConsumo Masivo', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  if (activeSessions[socketId]) {
    activeSessions[socketId].sock = sock;
  }

  sock.ev.on('creds.update', saveCreds);

  // ── Track message status updates (delivered/read) ──
  sock.ev.on('messages.update', updates => {
    for (const update of updates) {
      const jid = update.key?.remoteJid;
      if (!jid) continue;
      const session = activeSessions[socketId];
      if (!session) continue;

      // status 3 = read, status 2 = delivered
      if (update.update?.status === 3) {
        updateMessageStatus(jid, session.username, 'readAt');
        io.emit('stats_updated');
      }
    }
  });

  // ── Track incoming messages (client replies) ──
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      const session = activeSessions[socketId];
      if (!session) continue;
      updateMessageStatus(jid, session.username, 'repliedAt');
      io.emit('stats_updated');
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        io.to(socketId).emit('qr', qrDataUrl);
      } catch (err) {
        console.error('QR generation error:', err.message);
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : undefined;

      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[${username}] Closed (code: ${code}), reconnect: ${shouldReconnect}`);

      if (shouldReconnect && activeSessions[socketId]) {
        setTimeout(() => startWhatsAppSession(socketId, username, moraType), 3000);
      } else {
        io.to(socketId).emit('disconnected');
      }
    } else if (connection === 'open') {
      console.log(`[${username}] WhatsApp connected!`);
      io.to(socketId).emit('connected');
    }
  });

  return sock;
}

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('login', async ({ nombre, apellido, password }) => {
    if (password !== PASSWORD) {
      socket.emit('login_error', 'Contraseña incorrecta');
      return;
    }

    const username = `${nombre}_${apellido}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
    activeSessions[socket.id] = { username, nombre, apellido, sock: null, sending: false };

    socket.emit('login_success', { nombre, apellido });

    try {
      await startWhatsAppSession(socket.id, username);
    } catch (err) {
      console.error('Session start error:', err.message);
      socket.emit('qr_error', 'Error al iniciar WhatsApp');
    }
  });

  socket.on('regenerar_qr', async () => {
    const session = activeSessions[socket.id];
    if (!session) return;

    if (session.sock) {
      try { session.sock.end(); } catch (_) {}
      session.sock = null;
    }

    const sessionPath = path.join(SESSIONS_DIR, session.username);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    try {
      await startWhatsAppSession(socket.id, session.username);
    } catch (err) {
      console.error('Regenerar QR error:', err.message);
      socket.emit('qr_error', 'Error al regenerar QR');
    }
  });

  socket.on('send_messages', async ({ contacts, message, interval, moraType }) => {
    const session = activeSessions[socket.id];
    if (!session || !session.sock) {
      socket.emit('send_error', 'Sin sesión de WhatsApp activa');
      return;
    }
    if (session.sending) {
      socket.emit('send_error', 'Ya hay un envío en progreso');
      return;
    }

    session.sending = true;
    const delay = (interval || 40) * 1000;

    socket.emit('sending_start', { total: contacts.length });

    for (let i = 0; i < contacts.length; i++) {
      if (!activeSessions[socket.id]) break;

      const contact = contacts[i];
      const phone = contact.numero.toString().replace(/[^0-9]/g, '');
      const jid = `${phone}@s.whatsapp.net`;
      const text = message.replace(/\{nombre\}/gi, contact.nombre || '');

      try {
        await session.sock.sendMessage(jid, { text });

        // ── Record in stats ──
        recordMessage({
          jid,
          gestor: session.username,
          gestorNombre: `${session.nombre} ${session.apellido}`,
          contactNombre: contact.nombre || '',
          numero: phone,
          moraType: moraType || 'Sin clasificar',
          sentAt: new Date().toISOString(),
          readAt: null,
          repliedAt: null
        });

        socket.emit('message_sent', { index: i, nombre: contact.nombre, numero: phone, total: contacts.length });
        io.emit('stats_updated');
      } catch (err) {
        socket.emit('message_error', { index: i, nombre: contact.nombre, numero: phone, error: err.message });
      }

      if (i < contacts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (activeSessions[socket.id]) activeSessions[socket.id].sending = false;
    socket.emit('sending_complete', { total: contacts.length });
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    const session = activeSessions[socket.id];
    if (session?.sock) {
      try { session.sock.end(); } catch (_) {}
    }
    delete activeSessions[socket.id];
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`InterConsumo Masivo running on port ${PORT}`);
});
