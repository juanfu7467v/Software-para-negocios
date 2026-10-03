import express from "express";
import admin from "firebase-admin";
import crypto from "crypto";
import cors from "cors";
import cookieParser from "cookie-parser";
import { MercadoPagoConfig, Payment } from "mercadopago";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { generateInvoicePDF } from './pdfGenerator.js';
import axios from "axios";
import { Resend } from "resend";
import helmet from "helmet";
import { helmetConfig, corsAllowedOrigins } from './cspConfig.js';
import ReturnConfigServer from './returnConfigServer.js';

// Importar nuevos módulos
import { 
  logger, 
  getClientIp, 
  checkLoginBlock, 
  registerFailedLogin, 
  resetLoginAttempts, 
  validateRecaptcha,
  generateFingerprint,
  getLocationFromIP,
  RECAPTCHA_SITE_KEY,
  MAX_LOGIN_ATTEMPTS,
  BLOCK_DURATION_HOURS
} from './seguridad.js';

import { 
  initFirebase, 
  buildServiceAccountFromEnv, 
  db, 
  otorgarBeneficio, 
  enviarBienvenida, 
  enviarCorreoSospechoso, 
  enviarCorreoRechazo,
  enviarCorreoExito,
  enviarCorreoSoporte,
  registrarIntentoCompra,
  procesarComprasAbandonadas,
  PAQUETES_CREDITOS,
  PLANES_ILIMITADOS,
  buildInvoiceProxyUrl
} from './negocios.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');

// ================================================================
// 🔒 CONFIGURACIÓN CORS
// ================================================================

const allowedOrigins = corsAllowedOrigins;

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      logger.warn('CORS', 'Origen bloqueado por CORS', { origin });
      callback(new Error('No permitido por CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
}));

app.use(express.json());
app.use(cookieParser());
app.use(helmet(helmetConfig));

// ================================================================
// ✉️ CONFIGURACIÓN DE RESEND
// ================================================================

const resend = new Resend(process.env.RESEND_API_KEY);

// ================================================================
// 🔥 INICIALIZACIÓN DE FIREBASE
// ================================================================

const serviceAccount = buildServiceAccountFromEnv();
if (serviceAccount) {
  initFirebase(serviceAccount).catch(err => {
    logger.error('FIREBASE', 'Error crítico en inicialización asíncrona', err);
  });
} else {
  logger.error('FIREBASE', 'No se pudo inicializar Firebase - Service account no disponible');
}

// ================================================================
// 💳 CONFIGURACIÓN DE MERCADO PAGO
// ================================================================

const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const HOST_URL = process.env.HOST_URL || `https://${process.env.FLY_APP_NAME}.fly.dev`;

const mpClient = MERCADOPAGO_ACCESS_TOKEN ? new MercadoPagoConfig({
  accessToken: MERCADOPAGO_ACCESS_TOKEN.trim(),
  options: { timeout: 10000 }
}) : null;

// ================================================================
// 🛠️ FUNCIONES AUXILIARES
// ================================================================

/**
 * Extrae el proveedor a partir de una URL.
 */
function obtenerProveedor(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes('peliprex.masitaprex.com')) return 'peliprex.masitaprex.com';
    if (hostname.includes('drive.google.com')) return 'drive.google.com';
    return 'otro';
  } catch (e) {
    return 'desconocido';
  }
}

function obtenerCostoPorProveedor(provider) {
  if (provider === 'peliprex.masitaprex.com') return 25;
  if (provider === 'drive.google.com') return 3;
  return 3;
}

function serializeFirestoreValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeFirestoreValue);
  if (typeof value === 'object') {
    if (typeof value.seconds === 'number' && typeof value.nanoseconds === 'number') {
      return new Date(value.seconds * 1000).toISOString();
    }
    const output = {};
    for (const [key, nested] of Object.entries(value)) output[key] = serializeFirestoreValue(nested);
    return output;
  }
  return value;
}

function buildProfileActivity(perfil = {}) {
  const items = [
    { key: 'lastLoginAt', tipo: 'inicio_sesion', titulo: 'Último inicio de sesión' },
    { key: 'lastLogin', tipo: 'acceso', titulo: 'Acceso registrado' },
    { key: 'ultimaCompra', tipo: 'compra', titulo: 'Última compra' },
    { key: 'ultimaConsulta', tipo: 'consulta', titulo: 'Última consulta' },
    { key: 'fechaActualizacion', tipo: 'actualizacion', titulo: 'Perfil actualizado' },
    { key: 'updatedAt', tipo: 'actualizacion_documento', titulo: 'Documento actualizado' },
    { key: 'fechaActivacion', tipo: 'activacion', titulo: 'Cuenta activada' },
    { key: 'fechaCreacion', tipo: 'creacion', titulo: 'Cuenta creada' },
    { key: 'createdAt', tipo: 'creacion_registro', titulo: 'Registro creado' },
    { key: 'welcomeEmailSentAt', tipo: 'correo_bienvenida', titulo: 'Correo de bienvenida enviado' }
  ];

  return items.map(item => {
    const raw = perfil[item.key];
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return { campo: item.key, tipo: item.tipo, titulo: item.titulo, fecha: date.toISOString() };
  }).filter(Boolean).sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

// ================================================================
// 🧮 ESTADO DE PLAN (créditos / dedicado con cuota / ilimitado real)
// Normaliza también el legacy: antes los planes con cuota se guardaban
// como tipoPlan "ilimitado"; si tienen umbralConsultas + duración se
// interpretan como DEDICADOS para que consuman cuota y NUNCA se activen
// como ilimitado.
// ================================================================
function estadoPlan(userData = {}) {
  const tipoPlan = userData.tipoPlan || 'creditos';
  const esLegacyConCuota = tipoPlan === 'ilimitado' && userData.umbralConsultas && parseInt(userData.duracionDias || 0) > 0;
  const tipoEfectivo = esLegacyConCuota ? 'dedicado' : tipoPlan;

  const base = { tipoPlan: tipoEfectivo, tipoPlanAlmacenado: tipoPlan };

  if (tipoEfectivo === 'dedicado') {
    const umbral = parseInt(userData.umbralConsultas) || 0;
    const usadas = parseInt(userData.consultasUsadas) || 0;
    const restantes = Math.max(0, umbral - usadas);
    let vencido = false;
    if (userData.planIlimitadoHasta) {
      try {
        const fin = typeof userData.planIlimitadoHasta.toDate === 'function'
          ? userData.planIlimitadoHasta.toDate()
          : new Date(userData.planIlimitadoHasta);
        vencido = !isNaN(fin.getTime()) && fin < new Date();
      } catch (e) { vencido = false; }
    }
    return { ...base, umbral, consultasUsadas: usadas, consultasRestantes: restantes, vencido, activo: !vencido && restantes > 0 };
  }

  if (tipoEfectivo === 'ilimitado') {
    return { ...base, activo: true };
  }

  return { ...base, activo: true };
}

// ================================================================
// 🛣️ RUTAS DE LA API
// ================================================================

// Endpoint de login exitoso
app.post("/api/login-success", async (req, res) => {
  const context = 'LOGIN_SUCCESS_API';
  try {
    const { email, uid, displayName, isNewUser, idToken, deviceModel } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    try {
      if (db && uid) {
        const userRef = db.collection("usuarios").doc(uid);
        const userDoc = await userRef.get();
        
        if (userDoc.exists) {
          const userData = userDoc.data();
          const lastDevice = userData.lastDeviceModel;
          
          if (lastDevice && deviceModel && lastDevice !== deviceModel) {
            const ip = getClientIp(req);
            const location = await getLocationFromIP(ip);
            const nombre = displayName || userData.name || email.split('@')[0];
            
            logger.warn(context, '⚠️ Inicio de sesión sospechoso detectado (cambio de dispositivo)', {
              email, uid, oldDevice: lastDevice, newDevice: deviceModel, ip
            });
            
            enviarCorreoSospechoso(email, nombre, location, ip, req.headers['user-agent'], resend)
              .catch(err => logger.error(context, 'Error enviando correo sospechoso', err));
          }
          
          if (deviceModel) {
            await userRef.update({ 
              lastDeviceModel: deviceModel,
              lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
      }
    } catch (deviceError) {
      logger.error(context, 'Error verificando dispositivo sospechoso', deviceError);
    }

    await resetLoginAttempts(email);

    // ✅ CORRECCIÓN: Garantizar documento en "usuarios" tanto para usuarios nuevos
    // como para usuarios existentes que inician sesión con Google o GitHub.
    // Esto resuelve: créditos no asignados, "Error al cargar la información de tu plan",
    // y plan no reconocido en usuarios que regresan tras cerrar sesión.
    if (uid) {
      let waitAttempts = 0;
      while (!db && waitAttempts < 10) {
        await new Promise(r => setTimeout(r, 500));
        waitAttempts++;
      }

      if (db) {
        const nombre = displayName || email.split('@')[0];
        const userRef = db.collection("usuarios").doc(uid);
        const userDoc = await userRef.get();
        const userData = userDoc.exists ? userDoc.data() : null;

        // Construir objeto de actualización base (siempre se actualiza lastLogin)
        const updateData = {
          email,
          lastLogin: admin.firestore.FieldValue.serverTimestamp(),
          lastLoginAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // Si el documento no existe o no tiene créditos/plan → inicializar
        // (aplica a usuarios nuevos de Google/GitHub y a usuarios que no tienen documento en "usuarios")
        if (!userData || userData.creditos === undefined) {
          updateData.creditos = 9;
          updateData.tipoPlan = "creditos";
          logger.info(context, 'Asignando créditos de bienvenida en "usuarios"', { uid, email });
        }

        // Si es nuevo usuario: enviar correo de bienvenida y crear doc en "empresas"
        if (isNewUser) {
          const welcomeResult = await enviarBienvenida(email, nombre, resend);
          if (welcomeResult.success) {
            updateData.welcomeEmailSent = true;
            updateData.welcomeEmailSentAt = admin.firestore.FieldValue.serverTimestamp();
          }

          const empresaRef = db.collection("empresas").doc(uid);
          const secureToken = crypto.randomBytes(32).toString('hex');
          await empresaRef.set({
            uid,
            email,
            nombre,
            apiToken: secureToken,
            token: secureToken,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: 'active'
          }, { merge: true });
          logger.info(context, 'Datos guardados en colección empresas', { uid, email });
        }

        // Guardar (merge: true para no sobreescribir datos existentes como tipoPlan ilimitado)
        await userRef.set(updateData, { merge: true });
        logger.info(context, 'Documento en "usuarios" sincronizado correctamente', { uid, email, isNewUser: !!isNewUser });
      }
    }

    const cookieOptions = {
      httpOnly: true, secure: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/'
    };
    res.cookie('user_email', email, cookieOptions);
    res.cookie('user_uid', uid, cookieOptions);

    res.json({ success: true, message: 'Login success', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error(context, 'Error procesando login exitoso', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Endpoint de notificación de verificación
app.post("/api/notify-verification", async (req, res) => {
  const context = 'NOTIFY_VERIFICATION';
  try {
    const { uid, email, displayName } = req.body;
    if (!uid || !email) return res.status(400).json({ success: false, error: 'Se requiere uid y email' });

    let waitAttempts = 0;
    while (!db && waitAttempts < 10) {
      await new Promise(r => setTimeout(r, 500));
      waitAttempts++;
    }

    let alreadySent = false;
    if (db) {
      const userDoc = await db.collection("usuarios").doc(uid).get();
      if (userDoc.exists && userDoc.data().welcomeEmailSent) alreadySent = true;
    }

    if (!alreadySent) {
      const result = await enviarBienvenida(email, displayName || email.split('@')[0], resend);
      if (result.success && db) {
        await db.collection("usuarios").doc(uid).set({
          welcomeEmailSent: true,
          welcomeEmailSentAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        
        const userDoc = await db.collection("usuarios").doc(uid).get();
        if (!userDoc.exists || userDoc.data().creditos === undefined) {
          await db.collection("usuarios").doc(uid).set({ creditos: 11, tipoPlan: "creditos" }, { merge: true });
        }

        const empresaRef = db.collection("empresas").doc(uid);
        const secureToken = crypto.randomBytes(32).toString('hex');
        await empresaRef.set({
          uid,
          email,
          nombre: displayName || email.split('@')[0],
          apiToken: secureToken,
          token: secureToken,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          status: 'active'
        }, { merge: true });
        logger.info(context, 'Datos guardados en colección empresas tras verificación', { uid, email });
      }
      return res.json({ success: result.success, message: result.success ? 'Correo enviado' : 'Error enviando correo' });
    }
    res.json({ success: true, message: 'Ya enviado' });
  } catch (error) {
    logger.error(context, 'Error en notificación', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Endpoint de análisis con Gemini
app.post("/api/analyze", async (req, res) => {
  const { movieTitle, movieDescription } = req.body;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "GEMINI_API_KEY no configurada" });

  const prompt = `Actúa como un crítico de cine experto y redacta un análisis completo para "${movieTitle}". Sinopsis: "${movieDescription}". Sin negritas.`;
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' } }
    );
    res.json(response.data);
  } catch (error) {
    logger.error('GEMINI_API', 'Error en Gemini', error);
    res.status(500).json({ error: "Error en Gemini" });
  }
});

// ================================================================
// 💰 ENDPOINT DE COBRO POR REPRODUCCIÓN (BACKEND EXCLUSIVO)
// ================================================================
app.post("/api/peliprex/deduct", async (req, res) => {
  const context = 'DEDUCT_CREDITS';
  try {
    const { uid, cost, titulo } = req.body;
    if (!uid || !cost || cost <= 0) {
      return res.status(400).json({ success: false, message: 'Parámetros inválidos' });
    }

    if (!db) {
      return res.status(503).json({ success: false, message: 'Base de datos no disponible' });
    }

    const userRef = db.collection('usuarios').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    const userData = userDoc.data();
    const tipoPlan = userData.tipoPlan || 'creditos';
    const planEstado = estadoPlan(userData);

    // Si tiene plan ilimitado real (sin cuota definida), no descontamos
    if (planEstado.tipoPlan === 'ilimitado') {
      return res.json({ success: true, message: 'Plan ilimitado: sin descuento' });
    }

    // Plan dedicado con cuota: descuenta consultas del plan (nunca se trata como ilimitado)
    if (planEstado.tipoPlan === 'dedicado') {
      if (planEstado.vencido) {
        return res.status(402).json({ success: false, code: 'PLAN_EXPIRED', message: 'Tu plan dedicado ha vencido. Renueva tu plan para continuar.', ...planEstado });
      }
      if (planEstado.consultasRestantes < cost) {
        return res.status(402).json({ success: false, code: 'QUOTA_EXHAUSTED', message: `Tu plan dedicado solo tiene ${planEstado.consultasRestantes} consultas restantes.`, ...planEstado });
      }
      await userRef.update({ consultasUsadas: admin.firestore.FieldValue.increment(cost) });
      return res.json({ success: true, message: `Se descontaron ${cost} consultas de tu plan dedicado.`, consultasRestantes: planEstado.consultasRestantes - cost });
    }

    // Solo descuenta si el plan es por créditos
    if (tipoPlan !== 'creditos') {
      return res.status(400).json({ success: false, message: 'Plan no válido para descuento' });
    }

    const creditosActuales = parseInt(userData.creditos) || 0;

    // Validar créditos suficientes
    if (creditosActuales < cost) {
      return res.status(402).json({
        success: false,
        code: 'INSUFFICIENT_CREDITS',
        message: 'Créditos insuficientes para esta reproducción.',
        creditosActuales,
        creditosNecesarios: cost
      });
    }

    // Descontar atómicamente
    await userRef.update({
      creditos: admin.firestore.FieldValue.increment(-cost)
    });

    logger.info(context, `Descuento realizado: ${cost} créditos por "${titulo || 'sin título'}"`, { uid, cost });

    return res.json({
      success: true,
      message: `Se descontaron ${cost} créditos.`,
      creditosRestantes: creditosActuales - cost
    });

  } catch (error) {
    logger.error(context, 'Error interno al descontar créditos', error);
    return res.status(500).json({ success: false, message: 'Error interno del servidor' });
  }
});
// Endpoint de configuración pública
app.get("/api/config", (req, res) => {
  res.json({
    mercadopagoPublicKey: process.env.MERCADOPAGO_PUBLIC_KEY,
    recaptchaSiteKey: RECAPTCHA_SITE_KEY,
    firebaseConfig: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID
    },
    environment: process.env.NODE_ENV || 'production',
    peliprexBaseUrl: process.env.PELIPREX_BASE_URL,
    timestamp: new Date().toISOString()
  });
});

// ================================================================
// 🎬 PROXY PELIPREX — Oculta la URL real del servicio en Fly.io
// Todas las peticiones del frontend pasan por aquí.
// El cliente nunca ve la dirección https://peliprex-pe-v2.fly.dev
// ================================================================

const PELIPREX_UPSTREAM = process.env.PELIPREX_BASE_URL;

// Helper: reenvía una petición GET al upstream y devuelve la respuesta
async function peliprexGet(path, res) {
  if (!PELIPREX_UPSTREAM) {
    return res.status(503).json({ error: 'Servicio de películas no configurado' });
  }
  try {
    const upstream = await axios.get(`${PELIPREX_UPSTREAM}${path}`, {
      timeout: 15000,
      headers: { 'User-Agent': 'MasitaPrexBackend/1.0' }
    });
    return res.status(upstream.status).json(upstream.data);
  } catch (error) {
    const status = error.response?.status || 502;
    const data   = error.response?.data  || { error: 'Error en el servicio de películas' };
    logger.error('PELIPREX_PROXY', `Error en proxy GET ${path}`, error);
    return res.status(status).json(data);
  }
}

// GET /api/peliprex/peliculas  → /peliculas
app.get('/api/peliprex/peliculas', (req, res) => {
  peliprexGet('/peliculas', res);
});

// GET /api/peliprex/peliculas/categoria/:genre  → /peliculas/categoria/:genre
app.get('/api/peliprex/peliculas/categoria/:genre', (req, res) => {
  const genre = encodeURIComponent(req.params.genre);
  const limit = req.query.limit ? `?limit=${encodeURIComponent(req.query.limit)}` : '';
  peliprexGet(`/peliculas/categoria/${genre}${limit}`, res);
});

// GET /api/peliprex/vistohoy  → /vistohoy
app.get('/api/peliprex/vistohoy', (req, res) => {
  peliprexGet('/vistohoy', res);
});

// GET /api/peliprex/buscar?q=...  → /buscar?q=...
app.get('/api/peliprex/buscar', (req, res) => {
  const q = req.query.q ? `?q=${encodeURIComponent(req.query.q)}` : '';
  peliprexGet(`/buscar${q}`, res);
});

// GET /api/peliprex/sugerencias?titulo=...&generos=...&id=...
app.get('/api/peliprex/sugerencias', (req, res) => {
  const params = new URLSearchParams();
  if (req.query.titulo)  params.set('titulo',  req.query.titulo);
  if (req.query.generos) params.set('generos', req.query.generos);
  if (req.query.id)      params.set('id',      req.query.id);
  peliprexGet(`/sugerencias?${params.toString()}`, res);
});

// GET /api/peliprex/user/profile?email=...
app.get('/api/peliprex/user/profile', (req, res) => {
  const email = req.query.email ? `?email=${encodeURIComponent(req.query.email)}` : '';
  peliprexGet(`/user/profile${email}`, res);
});

// GET /api/peliprex/user/activity?email=...
app.get('/api/peliprex/user/activity', (req, res) => {
  const email = req.query.email ? `?email=${encodeURIComponent(req.query.email)}` : '';
  peliprexGet(`/user/activity${email}`, res);
});

// GET /api/peliprex/user/favorites?email=...
app.get('/api/peliprex/user/favorites', (req, res) => {
  const email = req.query.email ? `?email=${encodeURIComponent(req.query.email)}` : '';
  peliprexGet(`/user/favorites${email}`, res);
});

// GET /api/peliprex/user/add_history?email=...&titulo=...&imagen_url=...&pelicula_url=...
app.get('/api/peliprex/user/add_history', (req, res) => {
  const params = new URLSearchParams();
  if (req.query.email)       params.set('email',       req.query.email);
  if (req.query.titulo)      params.set('titulo',      req.query.titulo);
  if (req.query.imagen_url)  params.set('imagen_url',  req.query.imagen_url);
  if (req.query.pelicula_url) params.set('pelicula_url', req.query.pelicula_url);
  peliprexGet(`/user/add_history?${params.toString()}`, res);
});

// GET /api/peliprex/user/history?email=...
app.get('/api/peliprex/user/history', (req, res) => {
  const email = req.query.email ? `?email=${encodeURIComponent(req.query.email)}` : '';
  peliprexGet(`/user/history${email}`, res);
});

// GET /api/peliprex/user/history/remove?email=...&pelicula_url=...
app.get('/api/peliprex/user/history/remove', (req, res) => {
  const params = new URLSearchParams();
  if (req.query.email)        params.set('email',        req.query.email);
  if (req.query.pelicula_url) params.set('pelicula_url', req.query.pelicula_url);
  peliprexGet(`/user/history/remove?${params.toString()}`, res);
});

// GET /api/peliprex/user/history/clear?email=...
app.get('/api/peliprex/user/history/clear', (req, res) => {
  const email = req.query.email ? `?email=${encodeURIComponent(req.query.email)}` : '';
  peliprexGet(`/user/history/clear${email}`, res);
});

// GET /api/peliprex/user/favorites/remove?email=...&pelicula_url=...
app.get('/api/peliprex/user/favorites/remove', (req, res) => {
  const params = new URLSearchParams();
  if (req.query.email)        params.set('email',        req.query.email);
  if (req.query.pelicula_url) params.set('pelicula_url', req.query.pelicula_url);
  peliprexGet(`/user/favorites/remove?${params.toString()}`, res);
});

// GET /api/peliprex/user/favorites/clear?email=...
app.get('/api/peliprex/user/favorites/clear', (req, res) => {
  const email = req.query.email ? `?email=${encodeURIComponent(req.query.email)}` : '';
  peliprexGet(`/user/favorites/clear${email}`, res);
});

// GET /api/peliprex/user/remove_favorite  (sin lógica de créditos — solo eliminar)
app.get('/api/peliprex/user/remove_favorite', (req, res) => {
  const params = new URLSearchParams();
  if (req.query.email)       params.set('email',       req.query.email);
  if (req.query.titulo)      params.set('titulo',      req.query.titulo);
  if (req.query.imagen_url)  params.set('imagen_url',  req.query.imagen_url);
  if (req.query.pelicula_url) params.set('pelicula_url', req.query.pelicula_url);
  peliprexGet(`/user/remove_favorite?${params.toString()}`, res);
});

// ================================================================
// ⭐ ADD FAVORITE CON GESTIÓN SEGURA DE CRÉDITOS (backend-only)
//
// El frontend ya NO toca Firestore para créditos.
// Este endpoint:
//   1. Verifica que el usuario exista en Firestore.
//   2. Valida si tiene plan ilimitado o suficientes créditos.
//   3. Descuenta los créditos de forma atómica.
//   4. Llama al upstream para registrar el favorito.
//   5. Revierte el descuento si el upstream falla.
//   6. Devuelve el resultado final al frontend.
// ================================================================
const CREDITOS_FAVORITO = 3; // coste en créditos por añadir favorito

app.post('/api/peliprex/user/add_favorite', async (req, res) => {
  const context = 'ADD_FAVORITE_SECURE';

  if (!PELIPREX_UPSTREAM) {
    return res.status(503).json({ ok: false, message: 'Servicio de películas no configurado' });
  }

  const { uid, email, titulo, imagen_url, pelicula_url } = req.body;

  if (!uid || !email || !titulo || !pelicula_url) {
    return res.status(400).json({ ok: false, message: 'Faltan campos requeridos (uid, email, titulo, pelicula_url)' });
  }

  if (!db) {
    return res.status(503).json({ ok: false, message: 'Base de datos no disponible' });
  }

  try {
    // 1. Leer documento del usuario
    const userRef = db.collection('usuarios').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
    }

    const userData  = userDoc.data();
    const tipoPlan  = userData.tipoPlan || 'creditos';
    const creditos  = parseInt(userData.creditos) || 0;
    const planEstado = estadoPlan(userData);
    let descontadoDeCuota = false;

    // 2. Validar plan: dedicado con cuota / ilimitado real / créditos
    if (planEstado.tipoPlan === 'dedicado') {
      if (planEstado.vencido) {
        return res.status(402).json({ ok: false, code: 'PLAN_EXPIRED', message: 'Tu plan dedicado ha vencido. Renueva tu plan para añadir a favoritos.' });
      }
      if (planEstado.consultasRestantes < CREDITOS_FAVORITO) {
        return res.status(402).json({ ok: false, code: 'QUOTA_EXHAUSTED', message: `Te quedan ${planEstado.consultasRestantes} consultas en tu plan dedicado.`, consultasRestantes: planEstado.consultasRestantes });
      }

      // 3. Descontar de la cuota del plan dedicado
      await userRef.update({ consultasUsadas: admin.firestore.FieldValue.increment(CREDITOS_FAVORITO) });
      descontadoDeCuota = true;
    } else if (tipoPlan !== 'ilimitado') {
      if (creditos < CREDITOS_FAVORITO) {
        return res.status(402).json({
          ok: false,
          code: 'INSUFFICIENT_CREDITS',
          message: `Necesitas al menos ${CREDITOS_FAVORITO} créditos para añadir a favoritos.`,
          creditosActuales: creditos,
          creditosNecesarios: CREDITOS_FAVORITO
        });
      }

      // 3b. Descontar créditos de forma atómica
      await userRef.update({
        creditos: admin.firestore.FieldValue.increment(-CREDITOS_FAVORITO)
      });
    }

    // 4. Llamar al upstream para registrar el favorito
    try {
      const params = new URLSearchParams({ email, titulo, pelicula_url });
      if (imagen_url) params.set('imagen_url', imagen_url);

      const upstream = await axios.get(
        `${PELIPREX_UPSTREAM}/user/add_favorite?${params.toString()}`,
        { timeout: 12000, headers: { 'User-Agent': 'MasitaPrexBackend/1.0' } }
      );

      // 5. Éxito: devolver respuesta del upstream enriquecida
      return res.status(upstream.status).json({
        ...upstream.data,
        ok: true
      });

    } catch (upstreamError) {
      // 6. Revertir descuento si el upstream falló
      try {
        if (descontadoDeCuota) {
          await userRef.update({ consultasUsadas: admin.firestore.FieldValue.increment(-CREDITOS_FAVORITO) });
          logger.info(context, 'Consultas de plan dedicado revertidas tras fallo en upstream', { uid, email });
        } else if (tipoPlan !== 'ilimitado') {
          await userRef.update({ creditos: admin.firestore.FieldValue.increment(CREDITOS_FAVORITO) });
          logger.info(context, 'Créditos revertidos tras fallo en upstream', { uid, email });
        }
      } catch (revertError) {
        logger.error(context, 'Error crítico: no se pudieron revertir el descuento', { uid, email, revertError });
      }

      const status  = upstreamError.response?.status  || 502;
      const message = upstreamError.response?.data?.message || 'Error al registrar el favorito en el servicio externo';
      logger.error(context, 'Error en upstream add_favorite', { uid, email, status });
      return res.status(status).json({ ok: false, message });
    }

  } catch (error) {
    logger.error(context, 'Error interno en add_favorite seguro', error);
    return res.status(500).json({ ok: false, message: 'Error interno del servidor' });
  }
});

app.get('/api/usuarios/perfil', async (req, res) => {
  const context = 'GET_USER_PROFILE';
  try {
    const { uid, email } = req.query;

    if (!db) {
      return res.status(503).json({ ok: false, message: 'Base de datos no disponible' });
    }

    if (!uid && !email) {
      return res.status(400).json({ ok: false, message: 'Se requiere uid o email' });
    }

    let userDoc = null;

    if (uid) {
      const doc = await db.collection('usuarios').doc(uid).get();
      if (doc.exists) userDoc = doc;
    }

    if (!userDoc && email) {
      const snapshot = await db.collection('usuarios').where('email', '==', email).limit(1).get();
      if (!snapshot.empty) userDoc = snapshot.docs[0];
    }

    if (!userDoc || !userDoc.exists) {
      return res.status(404).json({ ok: false, message: 'Usuario no encontrado' });
    }

    const perfil = serializeFirestoreValue({ uid: userDoc.id, ...userDoc.data() });
    return res.json({ ok: true, perfil, actividad: buildProfileActivity(perfil) });
  } catch (error) {
    logger.error(context, 'Error obteniendo perfil de usuario', error);
    return res.status(500).json({ ok: false, message: 'Error interno del servidor' });
  }
});

// ================================================================
// 🆕 NUEVOS ENDPOINTS PARA REPRODUCCIÓN Y DESCARGA (COBRO AUTOMÁTICO)
// ================================================================

// POST /api/reproduccion/validar
// Valida si el usuario puede iniciar la reproducción (plan o créditos suficientes)
// y registra una sesión de reproducción para controlar los 6 minutos.
app.post('/api/reproduccion/validar', async (req, res) => {
  const context = 'VALIDAR_REPRODUCCION';
  try {
    const { uid, movieUrl } = req.body;
    if (!uid || !movieUrl) return res.status(400).json({ ok: false, error: 'uid y movieUrl requeridos' });
    if (!db) return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });

    const userRef = db.collection('usuarios').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    const userData = userDoc.data();
    const tipoPlan = userData.tipoPlan || 'creditos';
    const provider = obtenerProveedor(movieUrl);
    const costo = obtenerCostoPorProveedor(provider);
    const planEstado = estadoPlan(userData);

    if (planEstado.tipoPlan === 'ilimitado') {
      // Registrar sesión sin costo
      const sessionRef = await db.collection('reproducciones').add({
        uid,
        movieUrl,
        startTime: admin.firestore.FieldValue.serverTimestamp(),
        provider,
        costo: 0,
        descontado: false,
        tipoPlan: 'ilimitado'
      });
      return res.json({ ok: true, sessionId: sessionRef.id, requierePago: false });
    }

    if (planEstado.tipoPlan === 'dedicado') {
      // Plan dedicado con cuota: validar cuota restante y descontar al finalizar
      if (planEstado.vencido) {
        return res.status(402).json({ ok: false, code: 'PLAN_EXPIRED', message: 'Tu plan dedicado ha vencido. Renueva tu plan para continuar.' });
      }
      if (planEstado.consultasRestantes < costo) {
        return res.status(402).json({ ok: false, code: 'QUOTA_EXHAUSTED', message: `Te quedan ${planEstado.consultasRestantes} consultas en tu plan dedicado.`, consultasRestantes: planEstado.consultasRestantes });
      }
      const sessionRef = await db.collection('reproducciones').add({
        uid,
        movieUrl,
        startTime: admin.firestore.FieldValue.serverTimestamp(),
        provider,
        costo,
        descontado: false,
        tipoPlan: 'dedicado'
      });
      return res.json({ ok: true, sessionId: sessionRef.id, requierePago: true, costo });
    }

    // Plan créditos
    const creditos = parseInt(userData.creditos) || 0;
    if (creditos < costo) {
      return res.status(402).json({ ok: false, code: 'INSUFFICIENT_CREDITS', costo, creditos });
    }

    const sessionRef = await db.collection('reproducciones').add({
      uid,
      movieUrl,
      startTime: admin.firestore.FieldValue.serverTimestamp(),
      provider,
      costo,
      descontado: false,
      tipoPlan: 'creditos'
    });
    return res.json({ ok: true, sessionId: sessionRef.id, requierePago: true, costo });
  } catch (error) {
    logger.error(context, error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// POST /api/reproduccion/descontar
// Descuenta los créditos si ya han transcurrido al menos 6 minutos desde el inicio.
app.post('/api/reproduccion/descontar', async (req, res) => {
  const context = 'DESCONTAR_REPRODUCCION';
  try {
    const { sessionId, uid } = req.body;
    if (!sessionId || !uid) return res.status(400).json({ ok: false, error: 'sessionId y uid requeridos' });
    if (!db) return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });

    const sessionRef = db.collection('reproducciones').doc(sessionId);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) return res.status(404).json({ ok: false, error: 'Sesión no encontrada' });

    const sessionData = sessionDoc.data();
    if (sessionData.uid !== uid) return res.status(403).json({ ok: false, error: 'No autorizado' });
    if (sessionData.descontado) return res.json({ ok: true, message: 'Ya se había descontado anteriormente' });

    const startTime = sessionData.startTime.toDate();
    const ahora = new Date();
    const diffMin = (ahora - startTime) / (1000 * 60);
    if (diffMin < 6) {
      return res.status(400).json({ ok: false, error: 'Aún no han transcurrido 6 minutos de reproducción' });
    }

    if (sessionData.tipoPlan === 'ilimitado') {
      await sessionRef.update({ descontado: true, fechaDescuento: admin.firestore.FieldValue.serverTimestamp() });
      return res.json({ ok: true, message: 'Plan ilimitado, sin costo' });
    }

    const userRef = db.collection('usuarios').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    const costo = sessionData.costo || obtenerCostoPorProveedor(sessionData.provider);

    if (sessionData.tipoPlan === 'dedicado') {
      // Plan dedicado: descontar de la cuota de consultas (nunca como ilimitado)
      const planEstado = estadoPlan(userDoc.data());
      if (planEstado.vencido) {
        return res.status(402).json({ ok: false, code: 'PLAN_EXPIRED', message: 'Tu plan dedicado ha vencido. Renueva tu plan para continuar.' });
      }
      if (planEstado.consultasRestantes < costo) {
        return res.status(402).json({ ok: false, code: 'QUOTA_EXHAUSTED', message: 'Tu plan dedicado agotó sus consultas.', consultasRestantes: planEstado.consultasRestantes });
      }
      await userRef.update({ consultasUsadas: admin.firestore.FieldValue.increment(costo) });
      await sessionRef.update({ descontado: true, fechaDescuento: admin.firestore.FieldValue.serverTimestamp() });
      logger.info(context, `Descontadas ${costo} consultas del plan dedicado de ${uid} por ${sessionData.movieUrl}`);
      return res.json({ ok: true, message: `Se descontaron ${costo} consultas de tu plan dedicado` });
    }

    const creditos = parseInt(userDoc.data().creditos) || 0;
    if (creditos < costo) {
      return res.status(402).json({ ok: false, code: 'INSUFFICIENT_CREDITS', message: 'Créditos insuficientes en el momento del descuento' });
    }

    await userRef.update({ creditos: admin.firestore.FieldValue.increment(-costo) });
    await sessionRef.update({ descontado: true, fechaDescuento: admin.firestore.FieldValue.serverTimestamp() });

    logger.info(context, `Descontados ${costo} créditos a ${uid} por ${sessionData.movieUrl}`);
    return res.json({ ok: true, message: `Se han descontado ${costo} créditos` });
  } catch (error) {
    logger.error(context, error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// POST /api/descarga/validar
// Valida créditos/plan y descuenta inmediatamente para permitir la descarga.
app.post('/api/descarga/validar', async (req, res) => {
  const context = 'VALIDAR_DESCARGA';
  try {
    const { uid, movieUrl } = req.body;
    if (!uid || !movieUrl) return res.status(400).json({ ok: false, error: 'uid y movieUrl requeridos' });
    if (!db) return res.status(503).json({ ok: false, error: 'Base de datos no disponible' });

    const userRef = db.collection('usuarios').doc(uid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });

    const userData = userDoc.data();
    const tipoPlan = userData.tipoPlan || 'creditos';
    const provider = obtenerProveedor(movieUrl);
    const costo = obtenerCostoPorProveedor(provider);
    const planEstado = estadoPlan(userData);

    if (planEstado.tipoPlan === 'dedicado') {
      // Plan dedicado: descontar de la cuota de consultas
      if (planEstado.vencido) {
        return res.status(402).json({ ok: false, code: 'PLAN_EXPIRED', message: 'Tu plan dedicado ha vencido. Renueva tu plan para continuar.' });
      }
      if (planEstado.consultasRestantes < costo) {
        return res.status(402).json({ ok: false, code: 'QUOTA_EXHAUSTED', message: `Te quedan ${planEstado.consultasRestantes} consultas en tu plan dedicado.`, consultasRestantes: planEstado.consultasRestantes });
      }
      await userRef.update({ consultasUsadas: admin.firestore.FieldValue.increment(costo) });
      logger.info(context, `Descontadas ${costo} consultas del plan dedicado de ${uid} por descarga`);
    } else if (tipoPlan !== 'ilimitado') {
      const creditos = parseInt(userData.creditos) || 0;
      if (creditos < costo) {
        return res.status(402).json({ ok: false, code: 'INSUFFICIENT_CREDITS', costo, creditos });
      }
      await userRef.update({ creditos: admin.firestore.FieldValue.increment(-costo) });
      logger.info(context, `Descontados ${costo} créditos por descarga a ${uid}`);
    }

    return res.json({ ok: true, message: 'Descarga autorizada' });
  } catch (error) {
    logger.error(context, error);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

// ================================================================
// RESTO DE ENDPOINTS (webhooks, pagos, facturas, etc.)
// ================================================================

// Endpoint de validación de reCAPTCHA
app.post("/api/validate-recaptcha", async (req, res) => {
  try {
    const { recaptchaResponse } = req.body;
    const result = await validateRecaptcha(recaptchaResponse, process.env.RECAPTCHA_CLAVE_SECRETA);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Endpoint de login con bloqueo
app.post("/api/login", async (req, res) => {
  const context = 'LOGIN_API';
  try {
    const { email, recaptchaResponse, deviceId, deviceModel } = req.body;
    if (!email || !deviceId) return res.status(400).json({ success: false, error: 'Email and deviceId required' });

    const blockStatus = await checkLoginBlock(email);
    if (blockStatus.isBlocked) {
      return res.status(403).json({ success: false, error: 'account_blocked', remainingMinutes: blockStatus.remainingMinutes });
    }

    if (recaptchaResponse) {
      await validateRecaptcha(recaptchaResponse, process.env.RECAPTCHA_CLAVE_SECRETA);
    }

    res.json({ success: true, message: 'Login allowed' });
  } catch (error) {
    logger.error(context, 'Error en login', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// Endpoint para reportar login fallido
app.post("/api/report-failed-login", async (req, res) => {
  const context = 'REPORT_FAILED_LOGIN';
  try {
    const { email, deviceModel, errorType } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    const result = await registerFailedLogin(email, req, deviceModel);
    if (result.blocked) {
      const ip = getClientIp(req);
      const location = await getLocationFromIP(ip);
      await enviarCorreoSospechoso(email, null, location, ip, req.headers['user-agent'], resend);
    }
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error(context, 'Error reportando fallo', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Registrar el inicio del checkout para recuperar compras abandonadas.
app.post('/api/checkout-intent', async (req, res) => {
  const context = 'CHECKOUT_INTENT';
  try {
    const { uid, email, planId } = req.body || {};
    await registrarIntentoCompra(uid, email, planId);
    res.json({ success: true });
  } catch (error) {
    logger.error(context, 'No se pudo registrar la intención de compra', error);
    res.status(error.message === 'Database not available' ? 503 : 400).json({ success: false, error: error.message });
  }
});

// Endpoint de pago (corregido para usar tipoPlan)
app.post("/api/pay", async (req, res) => {
  const context = 'PAY_API';
  try {
    const { transaction_amount, token, description, installments, payment_method_id, payer, uid, tipoPlan } = req.body;
    if (!mpClient) return res.status(503).json({ error: 'Mercado Pago not configured' });
    if (!payer || !payer.email) {
      logger.error(context, 'Payer email missing in request body');
      return res.status(400).json({ error: 'Payer email is required' });
    }

    const payment = new Payment(mpClient);
    const result = await payment.create({
      body: {
        transaction_amount: Number(transaction_amount),
        token,
        description,
        installments: Number(installments),
        payment_method_id,
        payer,
        notification_url: `${HOST_URL}/api/webhook/mercadopago`,
        metadata: { 
          uid, 
          email: payer.email, 
          amount: transaction_amount, 
          tipoPlan,
          tipo_plan: tipoPlan // Duplicamos por seguridad para el webhook
        }
      }
    });

    if (result.status === 'approved') {
      await otorgarBeneficio(uid, payer.email, transaction_amount, 'MP_CARD_INSTANT', result.id.toString(), resend, tipoPlan);
    } else if (result.status === 'rejected' || result.status === 'cancelled') {
      let userName = payer.email.split('@')[0];
      try {
        if (db) {
          const collectionName = tipoPlan === 'revenue_recovery' ? 'empresas' : 'usuarios';
          let userSnap = await db.collection(collectionName).doc(uid).get();
          if (!userSnap.exists) {
            const alternativeCollection = collectionName === 'empresas' ? 'usuarios' : 'empresas';
            userSnap = await db.collection(alternativeCollection).doc(uid).get();
          }
          if (userSnap.exists) {
            const userData = userSnap.data();
            userName = userData.name || userData.displayName || userData.nombre || userName;
          }
        }
      } catch (err) {}
      
      enviarCorreoRechazo(
        payer.email, 
        userName, 
        result.id.toString(), 
        transaction_amount, 
        description || 'Compra en Consulta PE', 
        result.status_detail || result.status, 
        resend
      ).catch(err => logger.error(context, 'Error enviando correo de rechazo', err));
    }
    res.json(result);
  } catch (error) {
    logger.error(context, 'Error en pago', error);
    res.status(400).json({ error: error.message });
  }
});

// Webhook de Mercado Pago
app.post("/api/webhook/mercadopago", async (req, res) => {
  const context = 'WEBHOOK_MP';
  const webhookData = req.body;
  res.sendStatus(200);

  if (!mpClient) return;
  const isPaymentEvent = webhookData.action?.includes('payment') || webhookData.type === 'payment';
  if (isPaymentEvent) {
    try {
      const paymentId = webhookData.data?.id || webhookData.id;
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });

      if (paymentInfo.status === "approved") {
        const metadata = paymentInfo.metadata || {};
        const uid = metadata.uid || paymentInfo.external_reference;
        const email = metadata.email || paymentInfo.payer?.email;
        const amount = metadata.amount || paymentInfo.transaction_amount;
        const planId = metadata.tipo_plan || metadata.tipoPlan || metadata.plan_id;

        if (uid && planId) {
          await otorgarBeneficio(uid, email, amount, 'MP_WEBHOOK', paymentId.toString(), resend, planId);
        } else {
          logger.error(context, 'Datos insuficientes en webhook aprobado', { paymentId, uid, planId });
        }
      } else if (paymentInfo.status === "rejected" || paymentInfo.status === "cancelled") {
        const metadata = paymentInfo.metadata || {};
        const email = metadata.email || paymentInfo.payer?.email;
        const uid = metadata.uid;
        const tipoPlan = metadata.tipoPlan;
        
        if (email && uid) {
          let userName = email.split('@')[0];
          try {
            if (db) {
              const collectionName = tipoPlan === 'revenue_recovery' ? 'empresas' : 'usuarios';
              let userSnap = await db.collection(collectionName).doc(uid).get();
              if (!userSnap.exists) {
                const alternativeCollection = collectionName === 'empresas' ? 'usuarios' : 'empresas';
                userSnap = await db.collection(alternativeCollection).doc(uid).get();
              }
              if (userSnap.exists) {
                const userData = userSnap.data();
                userName = userData.name || userData.displayName || userData.nombre || userName;
              }
            }
          } catch (err) {}

          enviarCorreoRechazo(
            email,
            userName,
            paymentId.toString(),
            metadata.amount || paymentInfo.transaction_amount,
            paymentInfo.description || 'Compra en Consulta PE',
            paymentInfo.status_detail || paymentInfo.status,
            resend
          ).catch(err => logger.error(context, 'Error enviando correo de rechazo desde webhook', err));
        }
      }
    } catch (error) {
      logger.error(context, 'Error en webhook', error);
    }
  }
});

// ================================================================
// 🆕 NUEVOS ENDPOINTS PARA CONSULTAR ESTADO DE PAGO
// ================================================================

// Obtener estado de un pago por ID de Mercado Pago
app.get("/api/payment-status/:paymentId", async (req, res) => {
  try {
    const paymentId = req.params.paymentId;
    if (!paymentId) return res.status(400).json({ error: 'paymentId requerido' });

    if (!db) return res.status(503).json({ error: 'Database no disponible' });

    const pagoDoc = await db.collection("pagos_registrados").doc(paymentId).get();
    if (!pagoDoc.exists) {
      return res.json({ status: 'pending', processed: false });
    }

    const data = pagoDoc.data();
    res.json({
      status: data.estado || 'pending',
      processed: data.procesado || false,
      paymentId: paymentId
    });
  } catch (error) {
    logger.error('PAYMENT_STATUS', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener estado por external_reference (opcional)
app.get("/api/payment-reference/:externalRef", async (req, res) => {
  try {
    const externalRef = req.params.externalRef;
    if (!externalRef) return res.status(400).json({ error: 'externalRef requerido' });

    if (!db) return res.status(503).json({ error: 'Database no disponible' });

    const pagosQuery = await db.collection("pagos_registrados")
      .where("externalReference", "==", externalRef)
      .limit(1)
      .get();

    if (pagosQuery.empty) {
      return res.json({ status: 'pending', processed: false, paymentId: null });
    }

    const doc = pagosQuery.docs[0];
    const data = doc.data();
    res.json({
      status: data.estado || 'pending',
      processed: data.procesado || false,
      paymentId: doc.id
    });
  } catch (error) {
    logger.error('PAYMENT_REFERENCE', error);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ================================================================
// 🧾 MANEJADOR DE DESCARGA DE BOLETAS (NUEVO)
// ================================================================
const handleInvoiceDownload = async (req, res) => {
  const context = 'INVOICE_DOWNLOAD';

  try {
    const rawPaymentId = req.params.paymentId || req.params.paymentIdWithExt;
    const paymentId = (rawPaymentId || '').replace(/\.pdf$/i, '');

    if (!paymentId) {
      return res.status(400).json({ error: 'paymentId requerido' });
    }

    if (!db) {
      return res.status(503).json({ error: 'Database no disponible' });
    }

    const pagoDoc = await db.collection("pagos_registrados").doc(paymentId).get();
    if (!pagoDoc.exists) {
      return res.status(404).json({ error: 'Pago no encontrado' });
    }

    const data = pagoDoc.data();
    if (!data.procesado || data.estado !== 'approved') {
      return res.status(404).json({ error: 'La boleta aún no está disponible. Intenta en unos segundos.' });
    }

    const storedInvoiceData = data.invoiceData || {};
    const paymentDate = data.procesadoEn?.toDate?.() || data.fechaRegistro?.toDate?.() || new Date();
    const invoiceData = {
      orderId: paymentId,
      date: storedInvoiceData.date || paymentDate.toISOString(),
      email: storedInvoiceData.email || data.email || 'cliente@example.com',
      amount: storedInvoiceData.amount ?? data.monto,
      credits: storedInvoiceData.credits ?? data.creditosOtorgados ?? 0,
      description: storedInvoiceData.description || data.descripcion || 'Compra Consulta PE',
      type: storedInvoiceData.type || 'boleta'
    };

    const pdfPath = await generateInvoicePDF(invoiceData);
    try {
      const invoiceBuffer = await fs.promises.readFile(pdfPath);
      const fileName = `boleta-${paymentId}.pdf`;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', invoiceBuffer.length);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

      return res.send(invoiceBuffer);
    } finally {
      await fs.promises.rm(pdfPath, { force: true });
    }
  } catch (error) {
    logger.error(context, error);
    return res.status(500).json({ error: 'Error al obtener la boleta' });
  }
};

// Endpoint para descargar la boleta de venta (PDF)
app.get("/api/invoice/:paymentId", handleInvoiceDownload);
app.get("/boleta/:paymentIdWithExt", handleInvoiceDownload);

// Endpoint para obtener información del pago (ya existente, pero lo dejamos)
app.get("/api/payment/:paymentId", async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: 'Database not available' });
    const pagoDoc = await db.collection("pagos_registrados").doc(req.params.paymentId).get();
    if (!pagoDoc.exists) return res.status(404).json({ error: 'Payment not found' });
    
    const data = pagoDoc.data();
    const fecha = data.fechaRegistro?.toDate() || new Date();
    res.json({
      id: req.params.paymentId,
      email: data.email,
      monto: data.monto,
      creditos: data.creditosOtorgados || 0,
      descripcion: data.descripcion,
      fecha: fecha.toLocaleDateString('es-PE'),
      hora: fecha.toLocaleTimeString('es-PE'),
      estado: data.estado,
      procesado: data.procesado,
      tipoPlan: data.tipoPlanNuevo || 'creditos',
      pdfUrl: (data.pdfUrl || data.pdfStoragePath || data.pdfPublicUrl) ? buildInvoiceProxyUrl(req.params.paymentId) : null
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ================================================================
// SERVICIO DE ARCHIVOS ESTÁTICOS Y METADATOS (sin cambios relevantes)
// ================================================================

const PUBLIC_ROUTES = ['/login', '/register', '/verify', '/reset-password', '/disclaimer-apis', '/API-Docs'];

const injectGA = (html) => {
  const gaId = process.env.GOOGLE_ANALYTICS_ID;
  if (!gaId) return html;

  const gaScript = `
    <!-- Google Analytics 4 (GA4) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '${gaId}', {
        page_path: window.location.pathname,
      });
    </script>
  `;
  
  if (html.includes('</head>')) {
    return html.replace('</head>', `${gaScript}</head>`);
  }
  return gaScript + html;
};

const SOCIAL_BOTS = [
  'facebookexternalhit',
  'twitterbot',
  'whatsapp',
  'telegrambot',
  'linkedinbot',
  'discordbot',
  'slackbot'
];

const generateCroppedImageUrl = (imageUrl) => {
  if (!imageUrl || imageUrl.includes('flaticon.com')) return imageUrl;
  if (imageUrl.includes('drive.google.com')) {
    const match = imageUrl.match(/\/d\/([^/]+)/);
    if (match) {
      return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w1200`;
    }
  }
  return imageUrl;
};

const serveDynamicMetadata = async (req, res, next) => {
  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const isBot = SOCIAL_BOTS.some(bot => userAgent.includes(bot));
  const movieId = req.query.movie;

  if (movieId && (isBot || req.path.includes('PeliPREX.html') || req.path === '/PeliPREX')) {
    try {
      if (!db) {
        return next();
      }

      let movieData = null;
      const moviesRef = db.collection('peliculas');
      
      const doc = await moviesRef.doc(movieId).get();
      if (doc.exists) {
        movieData = doc.data();
        movieData.id = doc.id;
      } else {
        const querySnapshot = await moviesRef.where('titulo', '==', movieId).limit(1).get();
        if (!querySnapshot.empty) {
          movieData = querySnapshot.docs[0].data();
          movieData.id = querySnapshot.docs[0].id;
        }
      }

      if (movieData) {
        const title = `${movieData.titulo} - PeliPREX`;
        const description = (movieData.descripcion || `Ver ${movieData.titulo} en línea con la mejor calidad en PeliPREX.`).substring(0, 160);
        let imageUrl = generateCroppedImageUrl(movieData.imagen_url || 'https://cdn-icons-png.flaticon.com/128/747/747965.png');
        const pageUrl = `${HOST_URL}${req.path}?movie=${encodeURIComponent(movieId)}`;

        if (isBot) {
          const botHtml = `
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta property="og:type" content="video.movie">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${imageUrl}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:type" content="image/jpeg">
    <meta property="og:url" content="${pageUrl}">
    <meta property="og:site_name" content="PeliPREX HD">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${imageUrl}">
    <meta name="twitter:image:alt" content="${movieData.titulo}">
</head>
<body>
    <h1>${title}</h1>
    <p>${description}</p>
    <img src="${imageUrl}" alt="${title}">
</body>
</html>`;
          return res.send(botHtml);
        } else {
          req.dynamicMetadata = {
            title,
            description,
            imageUrl,
            pageUrl,
            movieData
          };
        }
      }
    } catch (error) {
      logger.error('METADATA_BOT', `Error obteniendo metadatos para película ${movieId}`, error);
    }
  }
  next();
};

const serveHtmlWithGA = (req, res, next) => {
  let fileName = '';
  if (req.path === '/') {
    fileName = 'home.html';
  } else if (PUBLIC_ROUTES.includes(req.path)) {
    fileName = `${req.path.substring(1)}.html`;
  } else if (req.path.endsWith('.html')) {
    fileName = req.path.substring(1);
  } else {
    const potentialFile = `${req.path.substring(1)}.html`;
    if (fs.existsSync(path.join(__dirname, 'public', potentialFile))) {
      fileName = potentialFile;
    }
  }

  if (fileName) {
    const filePath = path.join(__dirname, 'public', fileName);
    if (fs.existsSync(filePath)) {
      try {
        let html = fs.readFileSync(filePath, 'utf8');
        
        if (req.dynamicMetadata) {
          const { title, description, imageUrl, pageUrl } = req.dynamicMetadata;
          
          html = html.replace(/<title>.*?<\/title>/i, `<title>${title}</title>`);
          if (html.includes('name="description"')) {
            html = html.replace(/<meta name="description" content=".*?">/i, `<meta name="description" content="${description}">`);
          }

          const dynamicMetaTags = `
    <!-- Dynamic Open Graph -->
    <meta property="og:title" content="${title}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:image" content="${imageUrl}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:url" content="${pageUrl}" />
    <meta property="og:type" content="video.movie" />
    <meta property="og:site_name" content="PeliPREX HD" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${title}" />
    <meta name="twitter:description" content="${description}" />
    <meta name="twitter:image" content="${imageUrl}" />
    <meta name="twitter:image:alt" content="${title}" />
          `;

          html = html.replace(/<meta property="og:title"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:description"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:image"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:image:width"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:image:height"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:image:type"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:url"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:type"[^>]*>/gi, '');
          html = html.replace(/<meta property="og:site_name"[^>]*>/gi, '');
          html = html.replace(/<meta name="twitter:card"[^>]*>/gi, '');
          html = html.replace(/<meta name="twitter:title"[^>]*>/gi, '');
          html = html.replace(/<meta name="twitter:description"[^>]*>/gi, '');
          html = html.replace(/<meta name="twitter:image"[^>]*>/gi, '');
          html = html.replace(/<meta name="twitter:image:alt"[^>]*>/gi, '');
          
          html = html.replace('<head>', `<head>${dynamicMetaTags}`);
        }

        const metadataScript = `
<script>
  window.injectedMovieData = ${JSON.stringify(req.dynamicMetadata?.movieData || {})};
  function updateOGTagsFromServer(movie) {
    if (!movie || !movie.titulo) return;
    const setMeta = (selector, attr, value) => {
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement('meta');
        const parts = selector.match(/\\[(\\w+)="([^"]+)"\\]/);
        if (parts) {
          el.setAttribute(parts[1], parts[2]);
          document.head.appendChild(el);
        }
      }
      if (el) el.setAttribute(attr, value);
    };
    const titulo = movie.titulo || '';
    const descripcion = (movie.descripcion || 'Ver en PeliPREX HD').substring(0, 160);
    const imagen = movie.imagen_url || 'https://cdn-icons-png.flaticon.com/128/747/747965.png';
    setMeta('meta[property="og:title"]', 'content', titulo + ' | PeliPREX HD');
    setMeta('meta[property="og:description"]', 'content', descripcion);
    setMeta('meta[property="og:image"]', 'content', imagen);
    setMeta('meta[property="og:image:width"]', 'content', '1200');
    setMeta('meta[property="og:image:height"]', 'content', '630');
    setMeta('meta[name="twitter:title"]', 'content', titulo + ' | PeliPREX HD');
    setMeta('meta[name="twitter:description"]', 'content', descripcion);
    setMeta('meta[name="twitter:image"]', 'content', imagen);
  }
  if (window.injectedMovieData && window.injectedMovieData.titulo) {
    updateOGTagsFromServer(window.injectedMovieData);
  }
</script>
        `;

        
        html = html.replace('</head>', metadataScript + '</head>');
        html = injectGA(html);
        return res.send(html);
      } catch (err) {
        logger.error('GA_INJECTION', `Error inyectando GA en ${fileName}`, err);
        return res.sendFile(filePath);
      }
    }
  }
  next();
};

app.use(serveDynamicMetadata);
app.use(serveHtmlWithGA);
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get("/api", (req, res) => res.json({ status: "ok" }));

app.post("/api/support/send", async (req, res) => {
  const context = 'SUPPORT_SEND_API';
  try {
    const { name, email, subject, message, timestamp } = req.body;
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, error: 'Todos los campos son obligatorios' });
    }

    logger.info(context, 'Recibida nueva consulta de soporte', { email, subject });

    const result = await enviarCorreoSoporte({ name, email, subject, message, timestamp }, resend);

    if (result.success) {
      res.json({ success: true, message: 'Consulta enviada correctamente' });
    } else {
      res.status(500).json({ success: false, error: 'Error al enviar el correo de soporte' });
    }
  } catch (error) {
    logger.error(context, 'Error procesando envío de soporte', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ================================================================
// 🚫 MANEJO DE RUTAS/PÁGINAS INEXISTENTES (404)
// ================================================================
// Se ejecuta únicamente si ninguna ruta, archivo estático o handler
// anterior respondió la solicitud. Sirve la interfaz personalizada
// /public/error-404.html en lugar del mensaje por defecto de Express.
app.use((req, res) => {
  const errorPagePath = path.join(__dirname, 'public', 'error-404.html');

  if (fs.existsSync(errorPagePath)) {
    return res.status(404).sendFile(errorPagePath);
  }

  // Fallback de seguridad por si el archivo no está disponible
  logger.error('NOT_FOUND', 'error-404.html no encontrado en /public', { path: req.path });
  return res.status(404).send('404 - Página no encontrada');
});

app.use((err, req, res, next) => {
  logger.error('GLOBAL_ERROR', 'Error no manejado', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

//  SOLUCIÓN: abrir el puerto INMEDIATAMENTE, sin esperar a Firebase ni a
//  ninguna otra tarea de inicialización pesada. Fly.io "duerme" la máquina
//  cuando no hay tráfico (autostop) y la vuelve a levantar (autostart) al
//  llegar una petición; mientras el proceso no escuche en 0.0.0.0:PORT, el
//  proxy de Fly no puede enrutar esa primera petición y el usuario percibe
//  una demora larga. Antes, este bloque hacía `await initFirebase(...)` (y
//  encima un `process.exit(1)` si fallaba) ANTES de `app.listen(...)`, lo
//  cual retrasaba innecesariamente la apertura del puerto y podía incluso
//  tirar abajo la máquina por una falla de Firebase. Firebase ya se
//  inicializa de forma asíncrona más arriba (ver sección "🔥 INICIALIZACIÓN
//  DE FIREBASE"), así que aquí el servidor escucha primero y la
//  verificación de Firebase ocurre en segundo plano.
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  logger.info('SERVER', `🚀 Servidor escuchando en el puerto ${PORT} (Firebase inicializándose en segundo plano)`, { version: '3.6.1' });
});

// La inicialización de Firebase ya se dispara al cargar el módulo (arriba).
// Aquí solo verificamos, sin bloquear el arranque del servidor, que haya
// terminado correctamente, dejando constancia en los logs.
async function verificarInicializacionFirebase() {
  try {
    if (!serviceAccount) {
      logger.error('SERVER', '❌ Firebase no se pudo inicializar: Service account no disponible');
      return;
    }

    // Pequeña espera de seguridad para asegurar el enlace de la variable db
    if (!db) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    if (db) {
      logger.info('SERVER', '✅ Base de datos vinculada correctamente', { version: '3.6.1' });
    } else {
      logger.error('SERVER', '⚠️ Firebase todavía no está disponible tras la espera de verificación');
    }
  } catch (error) {
    logger.error('SERVER', '❌ Error verificando inicialización de Firebase', error);
  }
}

verificarInicializacionFirebase();

// Revisa periódicamente las intenciones vencidas. El estado queda en Firestore,
// por lo que un reinicio del proceso no pierde los abandonos pendientes.
const ABANDONED_CHECKOUT_POLL_MS = 60 * 1000;
setInterval(() => {
  procesarComprasAbandonadas(resend).catch(error => {
    logger.error('CHECKOUT_ABANDONED_WORKER', 'Error procesando compras abandonadas', error);
  });
}, ABANDONED_CHECKOUT_POLL_MS);
procesarComprasAbandonadas(resend).catch(error => {
  logger.error('CHECKOUT_ABANDONED_WORKER', 'Error en la primera revisión de compras abandonadas', error);
});
