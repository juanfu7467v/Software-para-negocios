// ================================================================
// 🔒 CONFIGURACIÓN CSP (Content Security Policy)
// ================================================================

const unique = (values) => [...new Set(values.filter(Boolean))];

export const corsAllowedOrigins = [
  'https://masitaprex.com',
  'https://www.masitaprex.com',
  'https://consulta-pe-abf99.firebaseapp.com',
  'https://consulta-pe-abf99.firebasestorage.app',
  'https://masitaprexv2.fly.dev'
];

const appOrigins = [
  'https://masitaprex.com',
  'https://www.masitaprex.com',
  'https://auth.masitaprex.com',
  'https://api.masitaprex.com',
  'https://peliprex.masitaprex.com',
  'https://peliprex-31wrsa.fly.dev',
  'https://peliprex.fly.dev',
  'https://masitaprexv2.fly.dev',
  'https://consulta-pe-abf99.firebaseapp.com',
  'https://consulta-pe-abf99.firebasestorage.app'
];

const googleAndFirebaseOrigins = [
  'https://accounts.google.com',
  'https://apis.google.com',
  'https://drive.google.com',
  'https://firestore.googleapis.com',
  'https://firebase.googleapis.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://generativelanguage.googleapis.com',
  'https://identitytoolkit.googleapis.com',
  'https://securetoken.googleapis.com',
  'https://www.google.com',
  'https://google.com',
  'https://www.googleapis.com',
  'https://www.gstatic.com',
  'https://www.googletagmanager.com',
  'https://www.google-analytics.com',
  'https://region1.google-analytics.com',
  'https://*.firebaseio.com',
  'https://*.googleapis.com',
  'https://www.recaptcha.net'
];

const cdnAndUiOrigins = [
  'https://archive.org',
  'https://blogger.googleusercontent.com',
  'https://cdn-icons-png.flaticon.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net',
  'https://cdn.plyr.io',
  'https://cdn.tailwindcss.com',
  'https://i.postimg.cc',
  'https://*.postimg.cc',
  'https://image.tmdb.org',
  'https://images.unsplash.com',
  'https://lh3.googleusercontent.com',
  'https://placehold.co',
  'https://remixicon.com',
  'https://unpkg.com',
  'https://via.placeholder.com',
  'https://1.bp.blogspot.com'
];

const paymentOrigins = [
  'https://api.mercadopago.com',
  'https://mercadopago.com',
  'https://pago.mercadopago.com.pe',
  'https://sdk.mercadopago.com',
  'https://www.mercadopago.com',
  'https://www.mercadopago.com.pe',
  'https://http2.mlstatic.com',
  'https://*.mercadopago.com',
  'https://*.mercadolibre.com'
];

const externalServiceOrigins = [
  'https://api.ipquery.io',
  'https://m.facebook.com',
  'https://www.facebook.com',
  'https://wa.me',
  'https://youtube.com',
  'https://www.youtube.com',
  'https://github.com',
  'https://www.github.com',
  'https://api.github.com',
  'https://www.appcreator24.com',
  'https://img.utdstc.com',
  'https://com-masitaorex.uptodown.com',
  'https://stc.utdstc.com',
  'https://apk.e-droid.net',
  'https://apkpure.com',
  'https://*.effectivegatecpm.com',
  'https://*.adsterra.com'
];

export const cspDomains = unique([
  "'self'",
  'data:',
  'blob:',
  ...appOrigins,
  ...googleAndFirebaseOrigins,
  ...cdnAndUiOrigins,
  ...paymentOrigins,
  ...externalServiceOrigins
]);

const commonRemoteSources = unique(cspDomains.filter(source => !['data:', 'blob:'].includes(source)));
const scriptSources = unique(["'self'", "'unsafe-inline'", "'unsafe-eval'", ...commonRemoteSources]);
const styleSources = unique(["'self'", "'unsafe-inline'", ...commonRemoteSources]);
const imageSources = unique(["'self'", 'data:', 'blob:', ...commonRemoteSources]);
const fontSources = unique(["'self'", 'data:', ...commonRemoteSources]);
const connectSources = unique(["'self'", 'blob:', ...commonRemoteSources]);
const frameSources = unique(["'self'", ...commonRemoteSources]);
const mediaSources = unique(["'self'", 'blob:', ...commonRemoteSources]);

export const helmetConfig = {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: scriptSources,
      scriptSrcElem: scriptSources,
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: styleSources,
      styleSrcElem: styleSources,
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: imageSources,
      fontSrc: fontSources,
      connectSrc: connectSources,
      frameSrc: frameSources,
      childSrc: frameSources,
      mediaSrc: mediaSources,
      objectSrc: ["'none'"],
      workerSrc: ["'self'", 'blob:'],
      manifestSrc: ["'self'", ...commonRemoteSources],
      prefetchSrc: ["'self'", ...commonRemoteSources],
      formAction: ["'self'", ...commonRemoteSources],
      frameAncestors: ["'self'", ...corsAllowedOrigins],
      baseUri: ["'self'"],
      upgradeInsecureRequests: []
    },
    reportOnly: false
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'unsafe-none' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  originAgentCluster: false,
  dnsPrefetchControl: { allow: true },
  frameguard: { action: 'sameorigin' },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  ieNoOpen: true,
  noSniff: true,
  permittedCrossDomainPolicies: { permittedPolicies: 'all' },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true
};
