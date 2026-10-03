import crypto from "crypto";
import axios from "axios";

// ================================================================
// 📋 LOGS MEJORADOS
// ================================================================

export const logger = {
  info: (context, message, data = {}) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INFO] [${context}] ${message}`, Object.keys(data).length ? data : '');
  },
  error: (context, message, error = null, data = {}) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR] [${context}] ${message}`,
      error ? `Error: ${error.message} - Stack: ${error.stack}` : '',
      Object.keys(data).length ? data : ''
    );
  },
  warn: (context, message, data = {}) => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] [WARN] [${context}] ${message}`, Object.keys(data).length ? data : '');
  }
};

// ================================================================
// 🔍 HELPERS DE IP
// ================================================================

export function getClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string" && xForwardedFor.length > 0) {
    return xForwardedFor.split(",")[0].trim();
  }
  return req.ip;
}

// ================================================================
// 🛡️ SISTEMA DE BLOQUEO DE INTENTOS FALLIDOS (CACHÉ EN MEMORIA)
// ================================================================

export const MAX_LOGIN_ATTEMPTS = 5;
export const BLOCK_DURATION_HOURS = 6;
export const BLOCK_DURATION_MS = BLOCK_DURATION_HOURS * 60 * 60 * 1000;

// Caché en memoria para intentos de login
export const loginAttemptsCache = new Map();

// Limpiar entradas expiradas cada hora
setInterval(() => {
  const now = Date.now();
  let expiredCount = 0;
  
  for (const [email, data] of loginAttemptsCache.entries()) {
    if (data.blockedUntil && data.blockedUntil < now) {
      loginAttemptsCache.delete(email);
      expiredCount++;
    } else if (!data.blockedUntil && (now - data.lastAttempt) > 24 * 60 * 60 * 1000) {
      loginAttemptsCache.delete(email);
      expiredCount++;
    }
  }
  
  if (expiredCount > 0) {
    logger.info('CACHE_CLEANUP', `Limpiadas ${expiredCount} entradas expiradas de loginAttemptsCache`);
  }
}, 60 * 60 * 1000);

/**
 * Obtener información de geolocalización por IP
 */
export async function getLocationFromIP(ip) {
  try {
    if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      return { 
        city: 'Local', 
        region: 'Localhost', 
        country: 'Local Network',
        isp: 'Red Local',
        type: 'Privada'
      };
    }

    try {
      const response = await axios.get(`https://api.ipquery.io/${ip}`, { timeout: 4000 });
      const data = response.data;
      
      if (data && data.location) {
        return {
          city: data.location.city || 'Desconocida',
          region: data.location.state || 'Desconocida',
          country: data.location.country || 'Desconocido',
          isp: data.isp?.info || 'Desconocido',
          type: data.risk?.is_vpn ? 'VPN/Proxy' : (data.risk?.is_tor ? 'Tor' : 'Residencial/Móvil'),
          timezone: data.location.timezone || 'Desconocida'
        };
      }
    } catch (apiError) {
      logger.warn('GEOLOCATION', 'Error con ipquery.io, intentando fallback', { ip, error: apiError.message });
    }

    const fallbackResponse = await axios.get(`https://ipapi.co/${ip}/json/`, { timeout: 3000 });
    const data = fallbackResponse.data;

    return {
      city: data.city || 'Desconocida',
      region: data.region || 'Desconocida',
      country: data.country_name || 'Desconocido',
      isp: data.org || 'Desconocido',
      type: 'Desconocido'
    };
  } catch (error) {
    logger.warn('GEOLOCATION', 'Error crítico obteniendo ubicación', { ip, error: error.message });
    return { city: 'Desconocida', region: 'Desconocida', country: 'Desconocido', isp: 'Desconocido', type: 'Desconocido' };
  }
}

/**
 * Verificar si un usuario está bloqueado
 */
export async function checkLoginBlock(email) {
  const context = 'CHECK_LOGIN_BLOCK';

  try {
    const now = Date.now();
    const attemptData = loginAttemptsCache.get(email);

    if (!attemptData) {
      return { isBlocked: false, attempts: 0 };
    }

    const { attempts, blockedUntil } = attemptData;

    if (blockedUntil && blockedUntil > now) {
      const remainingMinutes = Math.ceil((blockedUntil - now) / (1000 * 60));
      logger.warn(context, 'Usuario bloqueado', { 
        email, 
        attempts, 
        blockedUntil: new Date(blockedUntil).toISOString(),
        remainingMinutes 
      });

      return {
        isBlocked: true,
        attempts,
        blockedUntil: new Date(blockedUntil),
        remainingMinutes
      };
    }

    if (blockedUntil && blockedUntil <= now) {
      loginAttemptsCache.delete(email);
      logger.info(context, 'Bloqueo expirado, intentos reseteados', { email });
      return { isBlocked: false, attempts: 0 };
    }

    return { isBlocked: false, attempts: attempts || 0 };

  } catch (error) {
    logger.error(context, 'Error verificando bloqueo', error, { email });
    return { isBlocked: false, attempts: 0, error: true };
  }
}

/**
 * Validar coherencia del dispositivo
 */
export function validateDeviceCoherence(deviceModel, userAgent) {
  if (!deviceModel || deviceModel === 'Unknown Device') return true;
  return true;
}

/**
 * Generar fingerprint del dispositivo
 */
export function generateFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  const acceptLang = req.headers['accept-language'] || '';
  const encoding = req.headers['accept-encoding'] || '';
  
  const fingerprint = `${userAgent}|${acceptLang}|${encoding}`;
  return crypto.createHash('sha256').update(fingerprint).digest('hex');
}

/**
 * Registrar un intento fallido de login
 */
export async function registerFailedLogin(email, req, deviceModel = null) {
  const context = 'REGISTER_FAILED_LOGIN';

  try {
    const now = Date.now();
    const attemptData = loginAttemptsCache.get(email) || { 
      attempts: 0, 
      firstAttempt: now,
      lastAttempt: now,
      ips: [],
      userAgents: []
    };

    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'Unknown';

    attemptData.attempts += 1;
    attemptData.lastAttempt = now;
    
    if (!attemptData.ips.includes(ip)) {
      attemptData.ips.push(ip);
    }
    
    if (!attemptData.userAgents.includes(userAgent)) {
      attemptData.userAgents.push(userAgent);
    }

    const isCoherent = validateDeviceCoherence(deviceModel, userAgent);
    const newAttempts = attemptData.attempts;

    if (newAttempts >= MAX_LOGIN_ATTEMPTS || !isCoherent) {
      const blockedUntil = now + BLOCK_DURATION_MS;

      attemptData.blockedUntil = blockedUntil;
      attemptData.blockedAt = now;
      attemptData.isSuspicious = !isCoherent;

      loginAttemptsCache.set(email, attemptData);

      logger.warn(context, '🚫 Usuario bloqueado por intentos fallidos', {
        email,
        attempts: newAttempts,
        blockedUntil: new Date(blockedUntil).toISOString(),
        isSuspicious: !isCoherent,
        ip
      });

      return {
        blocked: true,
        attempts: newAttempts,
        blockedUntil: new Date(blockedUntil),
        isSuspicious: !isCoherent
      };
    }

    loginAttemptsCache.set(email, attemptData);
    
    logger.info(context, 'Intento fallido registrado', {
      email,
      attempts: newAttempts,
      remaining: MAX_LOGIN_ATTEMPTS - newAttempts
    });

    return {
      blocked: false,
      currentAttempts: newAttempts,
      maxAttempts: MAX_LOGIN_ATTEMPTS,
      remaining: MAX_LOGIN_ATTEMPTS - newAttempts
    };

  } catch (error) {
    logger.error(context, 'Error registrando intento fallido', error, { email });
    return { error: true };
  }
}

/**
 * Resetear intentos de login tras éxito
 */
export async function resetLoginAttempts(email) {
  if (loginAttemptsCache.has(email)) {
    loginAttemptsCache.delete(email);
    logger.info('RESET_LOGIN_ATTEMPTS', 'Intentos reseteados tras login exitoso', { email });
    return true;
  }
  return false;
}

// ================================================================
// 🔐 CONFIGURACIÓN DE RECAPTCHA
// ================================================================

export const RECAPTCHA_SITE_KEY = "6Lfy85ssAAAAAAV0CGl1-aoW-mLKjuKxxm0-YpNn";

export async function validateRecaptcha(recaptchaResponse, secretKey) {
  const context = 'RECAPTCHA_VALIDATION';

  if (!secretKey) {
    logger.error(context, 'Clave secreta de reCAPTCHA no configurada');
    throw new Error('Recaptcha secret key not configured');
  }

  if (!recaptchaResponse) {
    throw new Error('reCAPTCHA response is required');
  }

  let attempts = 0;
  const maxAttempts = 3;
  const baseDelay = 500;

  while (attempts < maxAttempts) {
    try {
      const verificationUrl = 'https://www.google.com/recaptcha/api/siteverify';
      
      const params = new URLSearchParams();
      params.append('secret', secretKey);
      params.append('response', recaptchaResponse);

      const response = await axios.post(verificationUrl, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 8000
      });

      const data = response.data;

      if (data.success) {
        logger.info(context, '✅ reCAPTCHA validado exitosamente', {
          score: data.score,
          action: data.action
        });
        return { success: true, score: data.score, action: data.action };
      } else {
        const errorCodes = data['error-codes'] || ['unknown-error'];
        logger.warn(context, '❌ reCAPTCHA rechazado', { errorCodes });

        const shouldRetry = !errorCodes.some(code => 
          code === 'timeout-or-duplicate' || 
          code === 'invalid-input-response' ||
          code === 'missing-input-response' ||
          code === 'bad-request'
        );

        if (!shouldRetry || attempts === maxAttempts - 1) {
          throw new Error('reCAPTCHA validation failed: ' + errorCodes.join(', '));
        }

        const delay = baseDelay * Math.pow(2, attempts);
        logger.info(context, `Reintentando validación reCAPTCHA en ${delay}ms`, { attempt: attempts + 1 });
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
      }
    } catch (error) {
      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
        logger.warn(context, 'Timeout en validación reCAPTCHA', { 
          attempt: attempts + 1,
          maxAttempts,
          error: error.message 
        });

        if (attempts === maxAttempts - 1) {
          logger.error(context, 'Máximo de reintentos alcanzado para validación reCAPTCHA', error);
          throw new Error('reCAPTCHA validation timeout after multiple attempts');
        }

        const delay = baseDelay * Math.pow(2, attempts);
        logger.info(context, `Reintentando después de timeout en ${delay}ms`, { attempt: attempts + 1 });
        await new Promise(resolve => setTimeout(resolve, delay));
        attempts++;
      } else {
        logger.error(context, 'Error en validación reCAPTCHA', error);
        throw error;
      }
    }
  }

  throw new Error('reCAPTCHA validation failed after maximum attempts');
}
