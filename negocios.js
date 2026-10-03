import admin from "firebase-admin";
import { MercadoPagoConfig, Payment } from "mercadopago";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import moment from "moment-timezone";
import { logger } from './seguridad.js';

// ================================================================
// 🧾 DATOS DE BOLETAS: se almacenan en Firestore y el PDF se genera bajo demanda.
// ================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================================================================
// 🔥 CONFIGURACIÓN DE FIREBASE
// ================================================================

export function buildServiceAccountFromEnv() {
  logger.info('FIREBASE_CONFIG', 'Construyendo service account desde variables de entorno individuales');

  const requiredVars = [
    'FIREBASE_PRIVATE_KEY',
    'FIREBASE_CLIENT_EMAIL',
    'FIREBASE_PROJECT_ID',
    'FIREBASE_PRIVATE_KEY_ID'
  ];

  const missingVars = requiredVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
    logger.error('FIREBASE_CONFIG', `Variables de Firebase faltantes: ${missingVars.join(', ')}`);
    return null;
  }

  try {
    const serviceAccount = {
      "type": process.env.FIREBASE_TYPE || "service_account",
      "project_id": process.env.FIREBASE_PROJECT_ID,
      "private_key_id": process.env.FIREBASE_PRIVATE_KEY_ID,
      "private_key": process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      "client_email": process.env.FIREBASE_CLIENT_EMAIL,
      "client_id": process.env.FIREBASE_CLIENT_ID,
      "auth_uri": process.env.FIREBASE_AUTH_URI || "https://accounts.google.com/o/oauth2/auth",
      "token_uri": process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
      "auth_provider_x509_cert_url": process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL || "https://www.googleapis.com/oauth2/v1/certs",
      "client_x509_cert_url": process.env.FIREBASE_CLIENT_X509_CERT_URL,
      "universe_domain": process.env.FIREBASE_UNIVERSE_DOMAIN || "googleapis.com"
    };

    logger.info('FIREBASE_CONFIG', 'Service account construido exitosamente', {
      project_id: serviceAccount.project_id,
      client_email: serviceAccount.client_email,
      has_private_key: !!serviceAccount.private_key
    });

    return serviceAccount;

  } catch (error) {
    logger.error('FIREBASE_CONFIG', 'Error construyendo service account', error);
    return null;
  }
}

export let db;

// ================================================================
// 🆕 NUEVAS FUNCIONES PARA MANEJO DE BOLETAS
// ================================================================
export function getPublicAppUrl() {
  const candidates = [
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
    process.env.WEB_URL,
    process.env.SITE_URL,
    process.env.HOST_URL
  ].filter(Boolean);

  const preferredUrl = candidates.find(url => /masitaprex\.com/i.test(url)) || 'https://www.masitaprex.com';
  return preferredUrl.replace(/\/+$/, '');
}

export function buildInvoiceProxyUrl(paymentId) {
  return `${getPublicAppUrl()}/boleta/${encodeURIComponent(paymentId)}.pdf`;
}

export async function initFirebase(serviceAccount) {
  if (serviceAccount && !admin.apps.length) {
    try {
      logger.info('FIREBASE', 'Inicializando Firebase Admin...');

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
        // storageBucket eliminado: Storage ya no se gestiona desde Firebase Admin
      });

      db = admin.firestore();

      db.settings({
        ignoreUndefinedProperties: true
      });

      logger.info('FIREBASE', 'Firebase Admin inicializado correctamente', {
        projectId: serviceAccount.project_id,
        clientEmail: serviceAccount.client_email
      });

      // Verificación asíncrona (sin await para no bloquear el arranque)
      db.collection('_healthcheck').doc('connection').get()
        .then(() => logger.info('FIRESTORE', 'Conexión a Firestore exitosa'))
        .catch(error => logger.error('FIRESTORE', 'Error verificando conexión', error));

    } catch (error) {
      logger.error('FIREBASE', 'Error crítico al inicializar Firebase Admin', error, {
        projectId: serviceAccount?.project_id,
        clientEmail: serviceAccount?.client_email
      });
      console.error('CRITICAL: Firebase no pudo inicializarse.');
    }
  } else if (admin.apps.length) {
    db = admin.firestore();
    logger.info('FIREBASE', 'Usando instancia existente de Firebase');
  }
}

// ================================================================
// 💳 CONFIGURACIÓN DE MERCADO PAGO Y MAPA DE PRECIOS SEGURO
// ================================================================

// Mapa de Precios Seguro (Backend)
export const MAPA_PLANES = {
  // Paquetes de Créditos
  "60_creditos": { precio: 10, creditos: 60, bonus: 3, tipo: "creditos", descripcion: "Paquete de 60 créditos + 3 bonus" },
  "125_creditos": { precio: 20, creditos: 125, bonus: 5, tipo: "creditos", descripcion: "Paquete de 125 créditos + 5 bonus" },
  "330_creditos": { precio: 50, creditos: 330, bonus: 20, tipo: "creditos", descripcion: "Paquete de 330 créditos + 20 bonus" },
  "700_creditos": { precio: 100, creditos: 700, bonus: 40, tipo: "creditos", descripcion: "Paquete de 700 créditos + 40 bonus" },
  "1500_creditos": { precio: 200, creditos: 1500, bonus: 80, tipo: "creditos", descripcion: "Paquete de 1500 créditos + 80 bonus" },
  
  // Planes Dedicados con Cuota — p. ej. 5,000 consultas por 30 días.
  // NUNCA se activan como ilimitado: tienen umbral de consultas y ventana de días.
  "plan_7_dias": { precio: 110, dias: 7, umbral: 330, tipo: "dedicado", descripcion: "Plan Dedicado 7 días (330 consultas)" },
  "plan_15_dias": { precio: 180, dias: 15, umbral: 600, tipo: "dedicado", descripcion: "Plan Dedicado 15 días (600 consultas)" },
  "plan_30_dias": { precio: 340, dias: 30, umbral: 1000, tipo: "dedicado", descripcion: "Plan Dedicado 30 días (1,000 consultas)" },
  "plan_60_dias": { precio: 580, dias: 60, umbral: 1800, tipo: "dedicado", descripcion: "Plan Dedicado 60 días (1,800 consultas)" },

  // Revenue Recovery (Mantener compatibilidad si existe)
  "plan_starter_rr": { precio: 29, dias: 30, tipo: "revenue_recovery", descripcion: "Plan Starter - Revenue Recovery OS" },
  "plan_business_rr": { precio: 79, dias: 30, tipo: "revenue_recovery", descripcion: "Plan Business - Revenue Recovery OS" },
  "plan_enterprise_rr": { precio: 199, dias: 30, tipo: "revenue_recovery", descripcion: "Plan Enterprise - Revenue Recovery OS" }
};

// Mantener para compatibilidad con código antiguo si es necesario, pero priorizar MAPA_PLANES
export const PAQUETES_CREDITOS = { 10: 60, 20: 125, 50: 330, 100: 700, 200: 1500 };
export const PLANES_ILIMITADOS = { 80: 7, 120: 15, 180: 30, 320: 60 };
const ABANDONED_CHECKOUT_DELAY_MS = 30 * 60 * 1000;
export const processedPaymentsCache = new Map();
export const paymentLocks = new Map();

export async function acquirePaymentLock(paymentRef, maxWaitMs = 10000) {
  const context = 'PAYMENT_LOCK';
  const startTime = Date.now();

  while (paymentLocks.has(paymentRef)) {
    if (Date.now() - startTime > maxWaitMs) {
      logger.warn(context, 'Timeout esperando lock', { paymentRef, waitedMs: maxWaitMs });
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  paymentLocks.set(paymentRef, Date.now());
  logger.info(context, '🔒 Lock adquirido', { paymentRef });
  return true;
}

export function releasePaymentLock(paymentRef) {
  const context = 'PAYMENT_LOCK';
  paymentLocks.delete(paymentRef);
  logger.info(context, '🔓 Lock liberado', { paymentRef });
}

/**
 * Otorgar beneficios al usuario tras un pago exitoso
 * Ahora valida contra el planId y el mapa de precios seguro
 */
export async function otorgarBeneficio(uid, email, montoPagado, processor, paymentRefString, resend, planId) {
  const context = 'OTORGAR_BENEFICIO';
  
  if (!db) {
    logger.error(context, 'Base de datos no disponible');
    return { status: 'error', message: 'Database not available' };
  }

  // Validación de Plan
  const planSeguro = MAPA_PLANES[planId];
  if (!planSeguro) {
    logger.error(context, 'PlanId no válido', { planId, uid });
    return { status: 'error', message: 'Invalid Plan ID' };
  }

  // Validación de Monto (Seguridad)
  const montoNum = Number(montoPagado);
  if (Math.abs(montoNum - planSeguro.precio) > 0.01) {
    logger.error(context, 'DISCREPANCIA DE MONTO DETECTADA', { 
      planId, 
      montoPagado: montoNum, 
      precioEsperado: planSeguro.precio,
      uid 
    });
    return { status: 'error', message: 'Payment amount mismatch' };
  }

  try {
    const lockAcquired = await acquirePaymentLock(paymentRefString);
    if (!lockAcquired) {
      return { status: 'error', message: 'Could not acquire payment lock' };
    }

    if (processedPaymentsCache.has(paymentRefString)) {
      const cached = processedPaymentsCache.get(paymentRefString);
      logger.info(context, 'Pago ya procesado (Cache)', { paymentRef: paymentRefString, uid: cached.uid });
      releasePaymentLock(paymentRefString);
      return { status: 'already_processed', pdfUrl: buildInvoiceProxyUrl(paymentRefString) };
    }

    const pagoDoc = db.collection("pagos_registrados").doc(paymentRefString);
    const pagoSnap = await pagoDoc.get();

    if (pagoSnap.exists && pagoSnap.data().procesado) {
      logger.info(context, 'Pago ya procesado (Firestore)', { paymentRef: paymentRefString });
      releasePaymentLock(paymentRefString);
      return { status: 'already_processed', pdfUrl: buildInvoiceProxyUrl(paymentRefString) };
    }

    if (!pagoSnap.exists) {
      logger.info(context, 'Creando documento de pago inicial', { paymentRef: paymentRefString });
      await pagoDoc.set({
        email: email,
        monto: montoNum,
        uid: uid,
        planId: planId,
        estado: "pending",
        procesado: false,
        fechaRegistro: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    const result = await db.runTransaction(async (t) => {
      const userDoc = db.collection("usuarios").doc(uid);
      const userSnap = await t.get(userDoc);

      if (!userSnap.exists) {
        logger.warn(context, 'Usuario no encontrado en colección usuarios, buscando en empresas', { uid });
        const empresaDoc = await t.get(db.collection("empresas").doc(uid));
        if (!empresaDoc.exists) {
          throw new Error(`Usuario ${uid} no encontrado en ninguna colección`);
        }
      }

      const userData = userSnap.data() || {};
      const creditosActuales = userData.creditos || 0;
      const tipoPlanActual = userData.tipoPlan || "creditos";
      const fechaActivacionActual = userData.fechaActivacion;
      const planIlimitadoHastaActual = userData.planIlimitadoHasta;
      const duracionDiasActual = userData.duracionDias || 0;

      let creditosOtorgados = 0;
      let descripcion = planSeguro.descripcion;
      let planOtorgado = null;

      // 1. Lógica para Revenue Recovery OS
      if (planSeguro.tipo === 'revenue_recovery') {
        const diasNuevos = planSeguro.dias;
        const ahora = new Date();
        const fechaFinPlan = moment(ahora).add(diasNuevos, 'days').toDate();
        const planName = planSeguro.descripcion.split(' - ')[0];

        // Actualizar colección empresas (Revenue Recovery)
        const empresaRef = db.collection("empresas").doc(uid);
        t.set(empresaRef, {
          plan: planName,
          planStatus: 'active',
          planExpiry: fechaFinPlan,
          activatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        planOtorgado = { dias: diasNuevos, fechaFin: fechaFinPlan, planName };

        t.update(pagoDoc, {
          descripcion,
          procesado: true,
          estado: "approved",
          procesadoEn: admin.firestore.FieldValue.serverTimestamp(),
          procesadoPor: processor,
          planOtorgado,
          tipoPlanNuevo: "revenue_recovery"
        });

        return {
          status: 'success',
          planOtorgado,
          descripcion,
          tipoPlanNuevo: "revenue_recovery"
        };
      }

      // 2. Lógica para Créditos
      if (planSeguro.tipo === 'creditos') {
        creditosOtorgados = planSeguro.creditos + (planSeguro.bonus || 0);
        const nuevosCreditos = creditosActuales + creditosOtorgados;

        t.update(userDoc, {
          creditos: nuevosCreditos,
          tipoPlan: "creditos",
          ultimaCompra: admin.firestore.FieldValue.serverTimestamp()
        });

        t.update(pagoDoc, {
          descripcion,
          procesado: true,
          estado: "approved",
          procesadoEn: admin.firestore.FieldValue.serverTimestamp(),
          procesadoPor: processor,
          creditosOtorgados,
          creditosAnteriores: creditosActuales,
          creditosNuevos: nuevosCreditos,
          tipoPlanNuevo: "creditos"
        });

        return {
          status: 'success',
          creditosOtorgados,
          creditosAnteriores: creditosActuales,
          creditosNuevos: nuevosCreditos,
          descripcion,
          tipoPlanNuevo: "creditos"
        };

      } 
      
      // 3. Lógica para Planes Dedicados con Cuota (p. ej. 5,000 consultas por 30 días)
      //    Tipo "dedicado": se guarda como tal, con umbral y consumo; NUNCA como ilimitado.
      if (planSeguro.tipo === 'dedicado') {
        const diasNuevos = planSeguro.dias;
        const umbralNuevo = planSeguro.umbral || 0;
        let duracionTotalDias;
        let fechaFinPlan;
        let umbralTotal;
        let consultasUsadasPrevias = 0;
        const ahora = new Date();

        const tienePlanDedicadoActivo = tipoPlanActual === "dedicado" &&
          fechaActivacionActual &&
          planIlimitadoHastaActual &&
          planIlimitadoHastaActual.toDate() > ahora;

        if (tienePlanDedicadoActivo) {
          duracionTotalDias = duracionDiasActual + diasNuevos;
          consultasUsadasPrevias = parseInt(userData.consultasUsadas) || 0;
          const umbralActual = parseInt(userData.umbralConsultas) || 0;
          umbralTotal = umbralActual > 0 ? umbralActual + umbralNuevo : umbralNuevo;
          fechaFinPlan = moment(fechaActivacionActual.toDate()).add(duracionTotalDias, 'days').toDate();
        } else {
          duracionTotalDias = diasNuevos;
          umbralTotal = umbralNuevo;
          consultasUsadasPrevias = 0;
          fechaFinPlan = moment(ahora).add(diasNuevos, 'days').toDate();
        }

        t.update(userDoc, {
          duracionDias: duracionTotalDias,
          planIlimitadoHasta: fechaFinPlan,
          umbralConsultas: umbralTotal,
          consultasUsadas: consultasUsadasPrevias,
          creditos: 0,
          tipoPlan: "dedicado",
          fechaActivacion: tienePlanDedicadoActivo ? fechaActivacionActual : admin.firestore.FieldValue.serverTimestamp(),
          ultimaCompra: admin.firestore.FieldValue.serverTimestamp()
        });

        planOtorgado = { dias: duracionTotalDias, diasAgregados: diasNuevos, cuotaConsultas: umbralTotal, fechaFin: fechaFinPlan };

        t.update(pagoDoc, {
          descripcion,
          procesado: true,
          estado: "approved",
          procesadoEn: admin.firestore.FieldValue.serverTimestamp(),
          procesadoPor: processor,
          planOtorgado,
          tipoPlanNuevo: "dedicado"
        });

        return {
          status: 'success',
          planOtorgado,
          descripcion,
          tipoPlanNuevo: "dedicado"
        };
      }

      // 4. Lógica para Planes Ilimitados reales (sin umbral de consultas)
      if (planSeguro.tipo === 'ilimitado') {
        const diasNuevos = planSeguro.dias;
        let duracionTotalDias;
        let fechaFinPlan;
        const ahora = new Date();

        const tienePlanIlimitadoActivo = tipoPlanActual === "ilimitado" &&
          fechaActivacionActual &&
          planIlimitadoHastaActual &&
          planIlimitadoHastaActual.toDate() > ahora;

        if (tienePlanIlimitadoActivo) {
          duracionTotalDias = duracionDiasActual + diasNuevos;
          fechaFinPlan = moment(fechaActivacionActual.toDate()).add(duracionTotalDias, 'days').toDate();
        } else {
          duracionTotalDias = diasNuevos;
          fechaFinPlan = moment(ahora).add(diasNuevos, 'days').toDate();
        }

        t.update(userDoc, {
          duracionDias: duracionTotalDias,
          planIlimitadoHasta: fechaFinPlan,
          creditos: 0,
          tipoPlan: "ilimitado",
          fechaActivacion: tienePlanIlimitadoActivo ? fechaActivacionActual : admin.firestore.FieldValue.serverTimestamp(),
          ultimaCompra: admin.firestore.FieldValue.serverTimestamp()
        });

        planOtorgado = { dias: duracionTotalDias, diasAgregados: diasNuevos, fechaFin: fechaFinPlan };

        t.update(pagoDoc, {
          descripcion,
          procesado: true,
          estado: "approved",
          procesadoEn: admin.firestore.FieldValue.serverTimestamp(),
          procesadoPor: processor,
          planOtorgado,
          tipoPlanNuevo: "ilimitado"
        });

        return {
          status: 'success',
          planOtorgado,
          descripcion,
          tipoPlanNuevo: "ilimitado"
        };
      }

      throw new Error(`Tipo de plan ${planSeguro.tipo} no reconocido`);
    });

    // Persistir en Firestore los datos inmutables necesarios para generar la boleta bajo demanda.
    const invoiceData = {
      orderId: paymentRefString,
      date: new Date().toISOString(),
      email: email || 'cliente@example.com',
      amount: montoNum,
      credits: result.creditosOtorgados || 0,
      description: result.descripcion || 'Compra Consulta PE',
      type: 'boleta'
    };

    await pagoDoc.update({
      invoiceData,
      pdfUrl: buildInvoiceProxyUrl(paymentRefString)
    });

    await cancelarIntentoCompra(uid, planId);

    const proxyUrl = buildInvoiceProxyUrl(paymentRefString);
    result.pdfUrl = proxyUrl;

    // Enviar correo de éxito automáticamente
    try {
      if (resend) {
        let nombreUsuario = email.split('@')[0];
        try {
          const userSnap = await db.collection("usuarios").doc(uid).get();
          if (userSnap.exists) {
            nombreUsuario = userSnap.data().name || userSnap.data().displayName || nombreUsuario;
          } else {
            const empresaSnap = await db.collection("empresas").doc(uid).get();
            if (empresaSnap.exists) {
              nombreUsuario = empresaSnap.data().nombre || nombreUsuario;
            }
          }
        } catch (e) {
          logger.error(context, 'Error obteniendo nombre para email', e);
        }

        enviarCorreoExito(
          email,
          nombreUsuario,
          paymentRefString,
          montoNum,
          result.descripcion,
          proxyUrl,
          resend
        ).catch(err => logger.error(context, 'Error en envío automático de email de éxito', err));
      }
    } catch (emailError) {
      logger.error(context, 'Error en envío automático de email de éxito', emailError);
    }

    processedPaymentsCache.set(paymentRefString, { uid, ...result });
    releasePaymentLock(paymentRefString);
    return result;

  } catch (error) {
    logger.error(context, 'Error procesando beneficio', error, { uid, paymentRef: paymentRefString });
    releasePaymentLock(paymentRefString);
    return { status: 'error', message: error.message };
  }
}

// ================================================================
// 📧 FUNCIONES DE ENVÍO DE CORREOS ELECTRÓNICOS
// ================================================================

// Función auxiliar para leer plantillas HTML
function readHtmlTemplate(templateName, replacements = {}) {
  const templatePath = path.join(__dirname, 'emails', templateName);
  try {
    let html = fs.readFileSync(templatePath, 'utf8');
    for (const [key, value] of Object.entries(replacements)) {
      const safeValue = String(value ?? '');
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, safeValue);
      html = html.replaceAll(`[${key}]`, safeValue);
    }
    return html;
  } catch (error) {
    logger.error('EMAIL_TEMPLATE', `Error leyendo plantilla ${templateName}`, error);
    return `<p>Error al cargar la plantilla. Por favor contacte a soporte.</p>`;
  }
}

/**
 * Envía correo de bienvenida a un nuevo usuario
 */
export async function enviarBienvenida(email, nombre, resend) {
  const context = 'EMAIL_BIENVENIDA';
  try {
    const html = readHtmlTemplate('bienvenida-usuario-nuevo.html', { nombre: nombre || email.split('@')[0] });
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex <noreply@masitaprex.com>',
      to: email,
      subject: 'Bienvenido a Masitaprex - Tu cuenta está lista',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de bienvenida enviado', { email, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de bienvenida', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Envía correo de alerta por inicio de sesión sospechoso
 */
export async function enviarCorreoSospechoso(email, nombre, location, ip, userAgent, resend) {
  const context = 'EMAIL_SOSPECHOSO';
  try {
    // Obtener información del dispositivo desde el User-Agent
    let dispositivo = 'Desconocido';
    let isp = 'Proveedor no identificado';
    let tipo_conexion = 'No disponible';
    
    if (userAgent) {
      if (userAgent.includes('Windows')) dispositivo = 'Windows PC';
      else if (userAgent.includes('Mac')) dispositivo = 'Mac';
      else if (userAgent.includes('iPhone')) dispositivo = 'iPhone';
      else if (userAgent.includes('Android')) dispositivo = 'Android';
      else if (userAgent.includes('Linux')) dispositivo = 'Linux';
    }

    const fecha_hora = moment().tz('America/Lima').format('DD/MM/YYYY HH:mm:ss');

    const html = readHtmlTemplate('intento-inicio-seccion-sospechoso.html', {
      nombre: nombre || email.split('@')[0],
      ubicacion: location || 'Ubicación desconocida',
      ip: ip || 'IP no registrada',
      isp: isp,
      tipo_conexion: tipo_conexion,
      fecha_hora: fecha_hora,
      dispositivo: dispositivo
    });

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Seguridad <seguridad@masitaprex.com>',
      to: email,
      subject: '⚠️ Alerta de seguridad: Inicio de sesión sospechoso detectado',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo sospechoso enviado', { email, ip, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo sospechoso', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Envía correo de rechazo de pago
 */
export async function enviarCorreoRechazo(email, nombre, orderId, monto, descripcion, estado, resend) {
  const context = 'EMAIL_RECHAZO';
  try {
    const html = readHtmlTemplate('compra-rechazada.html', {
      nombre: nombre || email.split('@')[0],
      descripcion: descripcion || 'Suscripción Masitaprex',
      orderId: orderId,
      monto: monto.toString()
    });

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Facturación <facturacion@masitaprex.com>',
      to: email,
      subject: 'Problema con tu pago en Masitaprex',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de rechazo enviado', { email, orderId, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de rechazo', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Envía correo de confirmación de compra exitosa
 */
export async function enviarCorreoExito(email, nombre, orderId, monto, descripcion, urlBoleta, resend) {
  const context = 'EMAIL_EXITO';
  try {
    const html = readHtmlTemplate('compra-exitosa.html', {
      nombre: nombre || email.split('@')[0],
      descripcion: descripcion || 'Compra en Consulta PE',
      orderId: orderId,
      monto: monto.toString(),
      url_boleta: urlBoleta || '#'
    });

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Facturación <facturacion@masitaprex.com>',
      to: email,
      subject: '¡Tu compra ha sido exitosa! - Consulta PE',
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de éxito enviado', { email, orderId, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de éxito', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Envía correo de soporte al administrador (o a la dirección configurada)
 */
export async function enviarCorreoCompraAbandonada({ email, nombre, planId, checkoutUrl }, resend) {
  const context = 'EMAIL_COMPRA_ABANDONADA';
  try {
    const plan = MAPA_PLANES[planId];
    if (!plan) throw new Error(`PlanId no válido: ${planId}`);

    const replacements = {
      nombre: nombre || email.split('@')[0],
      MONTO_SOLES: `S/ ${Number(plan.precio).toFixed(2)}`,
      CHECKOUT_URL: checkoutUrl
    };

    if (plan.tipo === 'creditos') {
      const totalCreditos = Number(plan.creditos || 0) + Number(plan.bonus || 0);
      replacements.CANTIDAD_CREDITOS = totalCreditos.toLocaleString('es-PE');
      replacements.CALCULO_CONSULTAS = `aproximadamente entre ${Math.floor(totalCreditos / 9).toLocaleString('es-PE')} y ${Math.floor(totalCreditos / 4).toLocaleString('es-PE')} consultas, según el tipo de consulta`;
    } else if (plan.tipo === 'dedicado') {
      replacements.DÍAS_PLAN = Number(plan.dias).toLocaleString('es-PE');
      replacements.CANTIDAD_CONSULTAS = Number(plan.umbral).toLocaleString('es-PE');
    }

    const templateName = plan.tipo === 'creditos'
      ? 'recarga-creditos-a-medias.html'
      : 'planes-intensivos-a-medias-de-laa-compra.html';
    const subject = plan.tipo === 'creditos'
      ? 'Tu recarga de créditos quedó pendiente'
      : 'Tu Plan Intensivo quedó pendiente';
    const html = readHtmlTemplate(templateName, replacements);
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex <noreply@masitaprex.com>',
      to: email,
      subject,
      html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de compra abandonada enviado', { email, planId, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de compra abandonada', { email, planId, error: error.message });
    return { success: false, error: error.message };
  }
}

export async function registrarIntentoCompra(uid, email, planId) {
  if (!db) throw new Error('Database not available');
  const plan = MAPA_PLANES[planId];
  if (!uid || !email || !plan) throw new Error('Datos de compra incompletos o plan inválido');
  const intentRef = db.collection('intenciones_compra').doc(`${uid}__${planId}`);
  const dueAt = new Date(Date.now() + ABANDONED_CHECKOUT_DELAY_MS);
  await intentRef.set({
    uid,
    email,
    planId,
    tipoCompra: plan.tipo,
    monto: Number(plan.precio),
    estado: 'pending',
    emailEnviado: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    dueAt: admin.firestore.Timestamp.fromDate(dueAt)
  }, { merge: true });
  return { success: true, dueAt: dueAt.toISOString() };
}

export async function cancelarIntentoCompra(uid, planId) {
  if (!db || !uid || !planId) return;
  const intentRef = db.collection('intenciones_compra').doc(`${uid}__${planId}`);
  await intentRef.set({
    estado: 'completed',
    emailEnviado: false,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function obtenerNombreUsuario(uid, email) {
  const fallback = email?.split('@')[0] || 'Usuario';
  try {
    const userSnap = await db.collection('usuarios').doc(uid).get();
    if (userSnap.exists) return userSnap.data().name || userSnap.data().displayName || fallback;
    const empresaSnap = await db.collection('empresas').doc(uid).get();
    return empresaSnap.exists ? (empresaSnap.data().nombre || fallback) : fallback;
  } catch (error) {
    logger.error('EMAIL_COMPRA_ABANDONADA', 'Error obteniendo nombre de usuario', error);
    return fallback;
  }
}

export async function procesarComprasAbandonadas(resend) {
  if (!db || !resend) return;
  const ahora = admin.firestore.Timestamp.now();
  const snapshot = await db.collection('intenciones_compra')
    .where('estado', '==', 'pending')
    .limit(50)
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!data.dueAt || data.dueAt.toMillis() > ahora.toMillis()) continue;
    const claimed = await db.runTransaction(async transaction => {
      const current = await transaction.get(doc.ref);
      if (!current.exists || current.data().estado !== 'pending') return false;
      transaction.update(doc.ref, { estado: 'processing', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) continue;

    const nombre = await obtenerNombreUsuario(data.uid, data.email);
    const planUrl = `${getPublicAppUrl()}/checkout.html?planId=${encodeURIComponent(data.planId)}&uid=${encodeURIComponent(data.uid)}&email=${encodeURIComponent(data.email)}`;
    const result = await enviarCorreoCompraAbandonada({ email: data.email, nombre, planId: data.planId, checkoutUrl: planUrl }, resend);
    await doc.ref.update({
      estado: result.success ? 'sent' : 'pending',
      emailEnviado: result.success,
      ...(result.success ? { sentAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  }
}

export async function enviarCorreoSoporte({ name, email, subject, message, timestamp }, resend) {
  const context = 'EMAIL_SOPORTE';
  try {
    const adminEmail = process.env.SUPPORT_EMAIL || 'soporte@masitaprex.com';
    const fecha = timestamp || new Date().toLocaleString('es-PE');
    
    const html = `
      <h2>Nuevo mensaje de contacto</h2>
      <p><strong>Nombre:</strong> ${name}</p>
      <p><strong>Correo:</strong> ${email}</p>
      <p><strong>Asunto:</strong> ${subject}</p>
      <p><strong>Fecha:</strong> ${fecha}</p>
      <p><strong>Mensaje:</strong></p>
      <p>${message.replace(/\n/g, '<br>')}</p>
    `;

    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Masitaprex Soporte <soporte@masitaprex.com>',
      to: adminEmail,
      replyTo: email,
      subject: `[Soporte] ${subject}`,
      html: html
    });
    if (error) throw new Error(error.message);
    logger.info(context, 'Correo de soporte enviado al administrador', { from: email, subject, messageId: data?.id });
    return { success: true, messageId: data?.id };
  } catch (error) {
    logger.error(context, 'Error enviando correo de soporte', { email, error: error.message });
    return { success: false, error: error.message };
  }
}

// ================================================================
// 🚀 WEBHOOK DE MERCADO PAGO (VALIDACIÓN OBLIGATORIA)
// ================================================================

export async function handleMercadoPagoWebhook(req, res) {
  const context = 'MP_WEBHOOK';
  const { type, data } = req.body;

  if (type !== 'payment') {
    return res.status(200).send('OK');
  }

  const paymentId = data.id;
  logger.info(context, 'Recibido webhook de pago', { paymentId });

  try {
    const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
    const payment = new Payment(mpClient);
    const paymentData = await payment.get({ id: paymentId });

    if (paymentData.status === 'approved') {
      const { external_reference, transaction_amount, metadata } = paymentData;
      
      // El external_reference suele contener el UID del usuario
      // El planId debe venir en metadata si lo configuramos en el checkout
      const uid = external_reference || metadata.user_id;
      const planId = metadata.plan_id;
      const email = paymentData.payer.email;

      if (!uid || !planId) {
        logger.error(context, 'Datos incompletos en el pago', { paymentId, uid, planId });
        return res.status(400).send('Incomplete payment data');
      }

      const result = await otorgarBeneficio(
        uid, 
        email, 
        transaction_amount, 
        'MercadoPago_Webhook', 
        paymentId.toString(), 
        false, 
        planId
      );

      logger.info(context, 'Beneficio procesado vía Webhook', { paymentId, result });
      return res.status(200).json(result);
    }

    return res.status(200).send('Payment not approved');

  } catch (error) {
    logger.error(context, 'Error en Webhook Mercado Pago', error);
    return res.status(500).send('Internal Server Error');
  }
}
