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

const PASSWORD = 'Interconsumo2026';
const activeSessions = {};
const logger = pino({ level: 'silent' });

async function startWhatsAppSession(socketId, username) {
  const sessionPath = path.join(SESSIONS_DIR, username);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // ── FIX: timeout para evitar que se quede colgado ──
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
        setTimeout(() => startWhatsAppSession(socketId, username), 3000);
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

  socket.on('login', async ({ nombre, apellido, password, cola }) => {
    if (password !== PASSWORD) {
      socket.emit('login_error', 'Contraseña incorrecta');
      return;
    }

    const isCoordinador = nombre?.toUpperCase() === 'COORDINADOR';

    if (isCoordinador) {
      // Coordinador: no inicia sesión de WhatsApp, solo confirma acceso al dashboard
      activeSessions[socket.id] = {
        username: 'coordinador_admin',
        nombre: 'COORDINADOR',
        apellido: 'ADMIN',
        cola: null,
        rol: 'coordinador',
        sock: null,
        sending: false
      };
      socket.emit('login_success', { nombre: 'COORDINADOR', apellido: 'ADMIN' });
      console.log(`[COORDINADOR] Dashboard access granted (socket: ${socket.id})`);
      return; // No inicia WhatsApp
    }

    // Gestor: flujo normal con WhatsApp
    const username = `${nombre}_${apellido}`.toLowerCase().replace(/[^a-z0-9_]/g, '');
    activeSessions[socket.id] = {
      username,
      nombre,
      apellido,
      cola: cola || null,
      rol: 'gestor',
      sock: null,
      sending: false
    };

    socket.emit('login_success', { nombre, apellido, cola });
    console.log(`[GESTOR] ${username} (cola: ${cola || 'N/A'}) logged in`);

    try {
      await startWhatsAppSession(socket.id, username);
    } catch (err) {
      console.error('Session start error:', err.message);
      socket.emit('qr_error', 'Error al iniciar WhatsApp');
    }
  });

  // ── NUEVO: regenerar QR borrando sesión corrupta ──
  socket.on('regenerar_qr', async () => {
    const session = activeSessions[socket.id];
    if (!session) return;

    // Terminar socket anterior si existe
    if (session.sock) {
      try { session.sock.end(); } catch (_) {}
      session.sock = null;
    }

    // Borrar sesión guardada para forzar QR nuevo
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

  socket.on('send_messages', async ({ contacts, message, interval }) => {
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
    const cola  = session.cola || 'N/A';

    console.log(`[${session.username}] Iniciando envío: ${contacts.length} mensajes | cola: ${cola}`);
    socket.emit('sending_start', { total: contacts.length });

    for (let i = 0; i < contacts.length; i++) {
      if (!activeSessions[socket.id]) break;

      const contact = contacts[i];
      const phone = contact.numero.toString().replace(/[^0-9]/g, '');
      const jid = `${phone}@s.whatsapp.net`;
      const text = message.replace(/\{nombre\}/gi, contact.nombre || '');

      try {
        await session.sock.sendMessage(jid, { text });
        socket.emit('message_sent', { index: i, nombre: contact.nombre, numero: phone, total: contacts.length });
        console.log(`[${session.username}|${cola}] ✓ Enviado → ${phone}`);
      } catch (err) {
        socket.emit('message_error', { index: i, nombre: contact.nombre, numero: phone, error: err.message });
        console.error(`[${session.username}|${cola}] ✗ Error → ${phone}: ${err.message}`);
      }

      if (i < contacts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (activeSessions[socket.id]) activeSessions[socket.id].sending = false;
    socket.emit('sending_complete', { total: contacts.length });
    console.log(`[${session.username}] Envío completo: ${contacts.length} mensajes`);
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

const PORT = process.env.PORT || 3000;

// ── Endpoint: resumen de sesiones activas (para dashboard coordinador) ──
app.get('/api/sessions', (req, res) => {
  const summary = Object.entries(activeSessions).map(([sid, s]) => ({
    username: s.username,
    nombre:   s.nombre,
    apellido: s.apellido,
    cola:     s.cola,
    rol:      s.rol,
    connected: !!s.sock,
    sending:  s.sending,
  }));
  res.json({ sessions: summary, total: summary.length });
});

server.listen(PORT, () => {
  console.log(`InterConsumo Masivo running on port ${PORT}`);
});
