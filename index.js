import 'dotenv/config';
import express from 'express';
import admin from 'firebase-admin';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const TZ = process.env.TZ || 'America/Lima';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.gstatic.com', 'https://www.googleapis.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://firebasestorage.googleapis.com'],
      connectSrc: ["'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://firebasestorage.googleapis.com', 'https://www.googleapis.com', 'https://accounts.google.com'],
      frameSrc: ['https://accounts.google.com', 'https://*.firebaseapp.com', 'https://*.web.app'],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
    }
  }
}));
app.use(express.json({ limit: '100kb' }));

let firestore = null;
let storageBucket = null;
let firebaseAdminReady = false;
try {
  let credential;
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (rawServiceAccount) {
    const serviceAccount = JSON.parse(rawServiceAccount);
    if (serviceAccount.private_key) serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credential = admin.credential.applicationDefault();
  }
  if (credential) {
    admin.initializeApp({
      credential,
      ...(process.env.FIREBASE_STORAGE_BUCKET ? { storageBucket: process.env.FIREBASE_STORAGE_BUCKET } : {})
    });
    firestore = admin.firestore();
    firestore.settings({ ignoreUndefinedProperties: true });
    if (process.env.FIREBASE_STORAGE_BUCKET) storageBucket = admin.storage().bucket();
    firebaseAdminReady = true;
    console.info('Firebase Admin inicializado.');
  } else {
    console.warn('Firebase no está configurado: las rutas de datos responderán 503 hasta añadir credenciales.');
  }
} catch (error) {
  console.error('No se pudo inicializar Firebase Admin:', error.message);
}

const firebaseWebConfig = {
  apiKey: process.env.FIREBASE_API_KEY || '',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
  projectId: process.env.FIREBASE_PROJECT_ID || '',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
  appId: process.env.FIREBASE_APP_ID || ''
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('El archivo debe ser JPG, PNG o WebP.'));
    }
    callback(null, true);
  }
});

function validateImageSignature(req, res, next) {
  const file = req.file;
  if (!file) return next();
  const bytes = file.buffer;
  const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isWebp = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  const signature = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : isWebp ? 'image/webp' : '';
  if (!signature || signature !== file.mimetype) return res.status(415).json({ error: 'El contenido del archivo no coincide con una imagen JPG, PNG o WebP válida.' });
  next();
}

const reservationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Has enviado varias solicitudes. Espera unos minutos e inténtalo de nuevo.' }
});

function requireFirestore(_req, res, next) {
  if (!firestore) return res.status(503).json({ error: 'El servicio de reservas aún no está conectado a Firebase.' });
  next();
}

async function authenticate(req, res, next) {
  if (!admin.apps.length) return res.status(503).json({ error: 'La autenticación no está configurada.' });
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  try {
    req.user = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch {
    return res.status(401).json({ error: 'Tu sesión expiró. Vuelve a iniciar sesión.' });
  }
}

async function requireOwnerBusiness(req, res, next) {
  try {
    const snap = await firestore.collection('negocios').where('duenoUid', '==', req.user.uid).limit(1).get();
    if (snap.empty) {
      req.business = null;
      return next();
    }
    req.business = { id: snap.docs[0].id, ...snap.docs[0].data() };
    next();
  } catch (error) {
    console.error('Error cargando negocio del administrador:', error);
    res.status(500).json({ error: 'No se pudo cargar tu negocio.' });
  }
}

function cleanText(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function slugify(value) {
  return cleanText(value, 50).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
function toMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
function localToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
function dayOfWeek(date) { return new Date(`${date}T12:00:00-05:00`).getDay(); }
function normalizeBusiness(body, existing = {}) {
  const name = cleanText(body.nombre ?? existing.nombre, 80);
  const whatsapp = cleanText(body.telefonoWhatsapp ?? existing.telefonoWhatsapp, 24).replace(/[^+\d]/g, '');
  const opening = body.horarioApertura ?? existing.horarioApertura ?? '08:00';
  const closing = body.horarioCierre ?? existing.horarioCierre ?? '22:00';
  const price = Number(body.precioHoraEstandar ?? existing.precioHoraEstandar ?? 0);
  const special = Number(body.precioHoraEspecial ?? existing.precioHoraEspecial ?? 0);
  const duration = Number(body.duracionMinutos ?? existing.duracionMinutos ?? 60);
  const resourceInput = body.recursos ?? existing.recursos ?? [];
  const recursos = Array.isArray(resourceInput) ? resourceInput.map((item) => {
    const nombre = cleanText(typeof item === 'string' ? item : item?.nombre, 50);
    const id = slugify(typeof item === 'string' ? item : item?.id || nombre);
    return nombre && id ? { id, nombre } : null;
  }).filter(Boolean).slice(0, 30) : [];
  const dias = Array.isArray(body.diasAtencion ?? existing.diasAtencion) ? (body.diasAtencion ?? existing.diasAtencion).map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6) : [0,1,2,3,4,5,6];
  return {
    nombre: name,
    telefonoWhatsapp: whatsapp,
    horarioApertura: opening,
    horarioCierre: closing,
    precioHoraEstandar: price,
    precioHoraEspecial: special,
    horaInicioEspecial: cleanText(body.horaInicioEspecial ?? existing.horaInicioEspecial, 5),
    horaFinEspecial: cleanText(body.horaFinEspecial ?? existing.horaFinEspecial, 5),
    duracionMinutos: duration,
    recursos: [...new Map(recursos.map(resource => [resource.id, resource])).values()],
    diasAtencion: [...new Set(dias)],
    ...(existing.qrYapeUrl ? { qrYapeUrl: existing.qrYapeUrl } : {}),
    actualizadoEn: admin.firestore.FieldValue.serverTimestamp()
  };
}
function getResource(business, resourceId) {
  return (business.recursos || []).find(resource => resource.id === resourceId);
}
function validateSlot(business, date, start) {
  if (!validDate(date) || date < localToday()) return 'Selecciona una fecha válida a partir de hoy.';
  if (!(business.diasAtencion || [0,1,2,3,4,5,6]).includes(dayOfWeek(date))) return 'El negocio no atiende ese día.';
  const startMin = toMinutes(start);
  const open = toMinutes(business.horarioApertura || '08:00');
  const close = toMinutes(business.horarioCierre || '22:00');
  const duration = Number(business.duracionMinutos || 60);
  if (![startMin, open, close].every(Number.isFinite) || !Number.isInteger(duration) || duration < 15 || duration > 480 || startMin < open || startMin + duration > close || (startMin - open) % duration !== 0) {
    return 'Ese bloque no coincide con el horario del negocio.';
  }
  if (date === localToday()) {
    const nowInLima = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    if (startMin <= toMinutes(nowInLima)) return 'Ese horario ya pasó. Elige un turno futuro.';
  }
  return null;
}
function priceFor(business, start) {
  const specialFrom = toMinutes(business.horaInicioEspecial || '99:99');
  const specialTo = toMinutes(business.horaFinEspecial || '00:00');
  const at = toMinutes(start);
  const isSpecial = Number(business.precioHoraEspecial) > 0 && Number.isFinite(specialFrom) && Number.isFinite(specialTo) && at >= specialFrom && at < specialTo;
  return Math.round(Number(isSpecial ? business.precioHoraEspecial : business.precioHoraEstandar) * Number(business.duracionMinutos || 60) / 60 * 100) / 100;
}
async function saveImage(file, objectPath) {
  if (!storageBucket) throw Object.assign(new Error('Configura FIREBASE_STORAGE_BUCKET para habilitar comprobantes e imágenes.'), { status: 503 });
  const token = crypto.randomUUID();
  const object = storageBucket.file(objectPath);
  await object.save(file.buffer, {
    resumable: false,
    metadata: { contentType: file.mimetype, cacheControl: 'private, max-age=3600', metadata: { firebaseStorageDownloadTokens: token } }
  });
  return {
    object,
    url: `https://firebasestorage.googleapis.com/v0/b/${storageBucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'TuTurno', firebaseAdmin: firebaseAdminReady, storage: Boolean(storageBucket) }));
app.get('/api/config', (_req, res) => res.json({ firebase: firebaseWebConfig, brand: 'TuTurno' }));

app.get('/api/negocio/:slug', requireFirestore, async (req, res) => {
  try {
    const slug = slugify(req.params.slug);
    const snap = await firestore.collection('negocios').doc(slug).get();
    if (!snap.exists) return res.status(404).json({ error: 'No encontramos este negocio.' });
    const data = snap.data();
    res.json({ id: snap.id, nombre: data.nombre, telefonoWhatsapp: data.telefonoWhatsapp, qrYapeUrl: data.qrYapeUrl || '', recursos: data.recursos || [], horarioApertura: data.horarioApertura || '08:00', horarioCierre: data.horarioCierre || '22:00', precioHoraEstandar: data.precioHoraEstandar || 0, precioHoraEspecial: data.precioHoraEspecial || 0, horaInicioEspecial: data.horaInicioEspecial || '', horaFinEspecial: data.horaFinEspecial || '', duracionMinutos: data.duracionMinutos || 60, diasAtencion: data.diasAtencion || [0,1,2,3,4,5,6] });
  } catch (error) {
    console.error('GET negocio:', error);
    res.status(500).json({ error: 'No se pudo cargar el negocio.' });
  }
});

app.get('/api/negocio/:slug/disponibilidad', requireFirestore, async (req, res) => {
  const { fecha, recursoId } = req.query;
  if (!validDate(fecha) || typeof recursoId !== 'string') return res.status(400).json({ error: 'Fecha o recurso inválido.' });
  try {
    const businessSnap = await firestore.collection('negocios').doc(slugify(req.params.slug)).get();
    if (!businessSnap.exists) return res.status(404).json({ error: 'No encontramos este negocio.' });
    const business = businessSnap.data();
    if (!getResource(business, recursoId)) return res.status(404).json({ error: 'No encontramos este espacio.' });
    const reservations = await firestore.collection('reservas').where('negocioId', '==', businessSnap.id).where('fecha', '==', fecha).get();
    res.json({ reservas: reservations.docs.map(doc => ({ id: doc.id, recursoId: doc.data().recursoId, horaInicio: doc.data().horaInicio, estado: doc.data().estado })).filter(item => item.recursoId === recursoId && ['pendiente', 'aprobado'].includes(item.estado)) });
  } catch (error) {
    console.error('GET disponibilidad:', error);
    res.status(500).json({ error: 'No se pudo consultar la disponibilidad.' });
  }
});

app.post('/api/reserva', reservationLimiter, requireFirestore, upload.single('comprobante'), validateImageSignature, async (req, res) => {
  const { slug, recursoId, fecha, horaInicio } = req.body;
  const clienteNombre = cleanText(req.body.clienteNombre, 100);
  const clienteTelefono = cleanText(req.body.clienteTelefono, 24).replace(/[^+\d]/g, '');
  if (!slug || !recursoId || !req.file || clienteNombre.length < 2 || !/^\+?\d{8,15}$/.test(clienteTelefono)) return res.status(400).json({ error: 'Completa tu nombre, teléfono y adjunta el comprobante.' });
  let uploaded;
  try {
    const businessRef = firestore.collection('negocios').doc(slugify(slug));
    const businessSnap = await businessRef.get();
    if (!businessSnap.exists) return res.status(404).json({ error: 'No encontramos este negocio.' });
    const business = businessSnap.data();
    const resource = getResource(business, recursoId);
    if (!resource) return res.status(400).json({ error: 'El espacio seleccionado ya no está disponible.' });
    const slotError = validateSlot(business, fecha, horaInicio);
    if (slotError) return res.status(400).json({ error: slotError });
    const startMin = toMinutes(horaInicio);
    const duration = Number(business.duracionMinutos || 60);
    const horaFin = `${String(Math.floor((startMin + duration) / 60)).padStart(2, '0')}:${String((startMin + duration) % 60).padStart(2, '0')}`;
    const id = `${resource.id}_${fecha}_${horaInicio.replace(':', '')}`;
    const reservationRef = firestore.collection('reservas').doc(id);
    uploaded = await saveImage(req.file, `negocios/${businessSnap.id}/comprobantes/${id}_${crypto.randomUUID()}`);
    const monto = priceFor(business, horaInicio);
    await firestore.runTransaction(async transaction => {
      const current = await transaction.get(reservationRef);
      if (current.exists && ['pendiente', 'aprobado'].includes(current.data().estado)) {
        throw Object.assign(new Error('Alguien tomó ese turno hace unos segundos. Elige otro horario.'), { status: 409 });
      }
      transaction.set(reservationRef, {
        id, negocioId: businessSnap.id, recursoId: resource.id, recursoNombre: resource.nombre,
        fecha, horaInicio, horaFin, clienteNombre, clienteTelefono,
        voucherUrl: uploaded.url, voucherPath: uploaded.object.name,
        estado: 'pendiente', monto, creadoEn: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    const message = `Hola, tengo una solicitud de reserva pendiente en ${business.nombre}.\nEspacio: ${resource.nombre}\nFecha: ${fecha}\nHorario: ${horaInicio}–${horaFin}\nCliente: ${clienteNombre}\nTeléfono: ${clienteTelefono}\nMonto: S/ ${monto.toFixed(2)}\nComprobante: ${uploaded.url}`;
    const whatsappNumber = (business.telefonoWhatsapp || '').replace(/\D/g, '');
    res.status(201).json({ ok: true, id, estado: 'pendiente', whatsappUrl: whatsappNumber ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}` : '', message: 'Solicitud enviada. El negocio confirmará tu turno.' });
  } catch (error) {
    if (uploaded?.object) uploaded.object.delete().catch(() => {});
    if (error.status === 409) return res.status(409).json({ error: error.message });
    console.error('POST reserva:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'No pudimos registrar la solicitud. Intenta nuevamente.' });
  }
});

app.get('/api/admin/negocio', requireFirestore, authenticate, requireOwnerBusiness, (_req, res) => res.json({ negocio: _req.business }));

app.post('/api/admin/negocio', requireFirestore, authenticate, requireOwnerBusiness, async (req, res) => {
  if (req.business) return res.status(409).json({ error: 'Tu cuenta ya tiene un negocio configurado.' });
  const slug = slugify(req.body.slug || req.body.nombre);
  if (slug.length < 3) return res.status(400).json({ error: 'El enlace necesita al menos 3 caracteres.' });
  const business = normalizeBusiness(req.body);
  const opening = toMinutes(business.horarioApertura);
  const closing = toMinutes(business.horarioCierre);
  if (!business.nombre || !business.telefonoWhatsapp || !business.recursos.length || !Number.isFinite(opening) || !Number.isFinite(closing) || opening >= closing || !Number.isFinite(business.precioHoraEstandar) || business.precioHoraEstandar < 0 || !Number.isFinite(business.precioHoraEspecial) || business.precioHoraEspecial < 0 || business.telefonoWhatsapp.replace(/\D/g, '').length < 8 || business.telefonoWhatsapp.replace(/\D/g, '').length > 15 || !Number.isInteger(business.duracionMinutos) || business.duracionMinutos < 15 || business.duracionMinutos > 480) return res.status(400).json({ error: 'Revisa nombre, WhatsApp, horarios, precio y al menos un espacio.' });
  try {
    const ref = firestore.collection('negocios').doc(slug);
    await firestore.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) throw Object.assign(new Error('Ese enlace ya está ocupado. Prueba otro nombre.'), { status: 409 });
      tx.set(ref, { ...business, id: slug, slug, duenoUid: req.user.uid, creadoEn: admin.firestore.FieldValue.serverTimestamp() });
    });
    res.status(201).json({ negocio: { ...business, id: slug, slug, duenoUid: req.user.uid } });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'No se pudo crear el negocio.' });
  }
});

app.put('/api/admin/negocio', requireFirestore, authenticate, requireOwnerBusiness, async (req, res) => {
  if (!req.business) return res.status(404).json({ error: 'Primero configura tu negocio.' });
  const business = normalizeBusiness(req.body, req.business);
  const opening = toMinutes(business.horarioApertura);
  const closing = toMinutes(business.horarioCierre);
  if (!business.nombre || !business.telefonoWhatsapp || !business.recursos.length || !Number.isFinite(opening) || !Number.isFinite(closing) || opening >= closing || !Number.isFinite(business.precioHoraEstandar) || business.precioHoraEstandar < 0 || !Number.isFinite(business.precioHoraEspecial) || business.precioHoraEspecial < 0 || business.telefonoWhatsapp.replace(/\D/g, '').length < 8 || business.telefonoWhatsapp.replace(/\D/g, '').length > 15 || !Number.isInteger(business.duracionMinutos) || business.duracionMinutos < 15 || business.duracionMinutos > 480) return res.status(400).json({ error: 'Revisa nombre, WhatsApp, horarios, precio y al menos un espacio.' });
  try {
    await firestore.collection('negocios').doc(req.business.id).set(business, { merge: true });
    res.json({ negocio: { ...req.business, ...business } });
  } catch (error) {
    console.error('PUT negocio:', error);
    res.status(500).json({ error: 'No se pudieron guardar los ajustes.' });
  }
});

app.post('/api/admin/negocio/qr', requireFirestore, authenticate, requireOwnerBusiness, upload.single('qr'), validateImageSignature, async (req, res) => {
  if (!req.business) return res.status(404).json({ error: 'Primero configura tu negocio.' });
  if (!req.file) return res.status(400).json({ error: 'Selecciona una imagen PNG, JPG o WebP.' });
  let uploaded;
  try {
    uploaded = await saveImage(req.file, `negocios/${req.business.id}/qr/${crypto.randomUUID()}`);
    await firestore.collection('negocios').doc(req.business.id).update({ qrYapeUrl: uploaded.url, qrYapePath: uploaded.object.name, actualizadoEn: admin.firestore.FieldValue.serverTimestamp() });
    res.json({ qrYapeUrl: uploaded.url });
  } catch (error) {
    if (uploaded?.object) uploaded.object.delete().catch(() => {});
    console.error('POST QR:', error);
    res.status(error.status || 500).json({ error: error.message || 'No se pudo guardar el QR.' });
  }
});

app.get('/api/admin/reservas', requireFirestore, authenticate, requireOwnerBusiness, async (req, res) => {
  if (!req.business) return res.status(404).json({ error: 'Primero configura tu negocio.' });
  try {
    const snapshot = await firestore.collection('reservas').where('negocioId', '==', req.business.id).get();
    const reservas = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id })).sort((a, b) => `${b.fecha} ${b.horaInicio}`.localeCompare(`${a.fecha} ${a.horaInicio}`)).slice(0, 300);
    res.json({ reservas });
  } catch (error) {
    console.error('GET reservas admin:', error);
    res.status(500).json({ error: 'No se pudieron cargar las reservas.' });
  }
});

app.put('/api/admin/reserva/:id/estado', requireFirestore, authenticate, requireOwnerBusiness, async (req, res) => {
  if (!req.business) return res.status(404).json({ error: 'Primero configura tu negocio.' });
  const estado = req.body.estado;
  if (!['aprobado', 'rechazado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido.' });
  try {
    const ref = firestore.collection('reservas').doc(cleanText(req.params.id, 180));
    await firestore.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().negocioId !== req.business.id) throw Object.assign(new Error('No encontramos esa solicitud.'), { status: 404 });
      if (snap.data().estado !== 'pendiente') throw Object.assign(new Error('La solicitud ya fue procesada.'), { status: 409 });
      tx.update(ref, { estado, actualizadoEn: admin.firestore.FieldValue.serverTimestamp(), actualizadoPor: req.user.uid });
    });
    res.json({ ok: true, estado });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'No se pudo actualizar la reserva.' });
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
app.get(['/admin', '/admin/*', '/reservar/:slug'], (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'La imagen no puede superar 8 MB.' : 'No se pudo procesar el archivo.' });
  if (error.message?.includes('JPG, PNG')) return res.status(415).json({ error: error.message });
  console.error('Error no controlado:', error);
  res.status(500).json({ error: 'Ocurrió un error inesperado.' });
});

app.listen(PORT, '0.0.0.0', () => console.info(`TuTurno escuchando en 0.0.0.0:${PORT}`));
