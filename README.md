# 📱 WA Masivo v2 — Multi-usuario

App web para envío masivo de WhatsApp. Cada usuario entra desde el navegador, escanea su propio QR y envía mensajes. **Sin instalar nada.**

---

## 🚀 Deploy en Railway (recomendado — gratis / $5/mes)

### 1. Sube el código a GitHub
```bash
git init
git add .
git commit -m "WA Masivo inicial"
# Crea un repo en github.com y sigue las instrucciones
git remote add origin https://github.com/TU_USUARIO/wa-masivo.git
git push -u origin main
```

### 2. Deploy en Railway
1. Ve a **railway.app** → New Project → Deploy from GitHub
2. Selecciona tu repositorio
3. Railway detecta Node.js automáticamente y hace deploy

### 3. Variables de entorno (Railway → Variables)
```
JWT_SECRET=una-clave-secreta-larga-y-segura-aqui
```

### 4. ¡Listo! 🎉
Railway te da una URL tipo `https://wa-masivo-production.up.railway.app`

---

## 🌐 Deploy en Render (alternativa gratis)

1. Ve a **render.com** → New Web Service → conecta tu GitHub
2. Build command: `npm install`
3. Start command: `npm start`
4. Agrega env var: `JWT_SECRET=tu-clave-secreta`

> ⚠️ Render en plan gratis duerme tras 15min de inactividad. Railway es más estable.

---

## 👤 Usuarios por defecto

| Usuario | Contraseña | Rol |
|---------|-----------|-----|
| `admin` | `admin123` | Administrador |
| `usuario1` | `pass123` | Usuario |

> ⚠️ **Cambia las contraseñas** después del primer login editando `users.json` o desde el panel de Admin.

---

## 📋 Formato del CSV/Excel

```csv
telefono,nombre
5215512345678,María López
5215587654321,Juan García
```

- Teléfonos con código de país (ej: `521` para México)
- El archivo se puede llamar como sea, las columnas se detectan automáticamente

---

## ⚙️ Configuración avanzada

**Variables de entorno disponibles:**
- `JWT_SECRET` — clave para firmar tokens (obligatorio en producción)
- `PORT` — puerto del servidor (Railway/Render lo ponen automáticamente)

---

## 🔒 Seguridad
- Cada usuario tiene su sesión de WhatsApp completamente separada
- Las sesiones de WhatsApp se guardan en `.wwebjs_auth/` (persistente entre reinicios en Railway con volumen)
- Los tokens JWT expiran en 24h

---

## 📦 Stack técnico
- **Backend:** Node.js + Express + Socket.IO
- **WhatsApp:** whatsapp-web.js (Puppeteer)
- **Auth:** JWT + bcrypt
- **Frontend:** HTML/CSS/JS vanilla (sin frameworks)
