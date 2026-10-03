import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const appRoot = document.querySelector('#app');
const toastRoot = document.querySelector('#toast');
let auth = null;
let currentUser = null;
let business = null;
let reservations = [];
let activeTab = 'reservas';
let toastTimer;
let dashboardRefreshTimer;
const weekNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const weekShort = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const money = value => `S/ ${Number(value || 0).toFixed(2)}`;

function notify(message, isError = false) {
  toastRoot.textContent = message;
  toastRoot.classList.toggle('error', isError);
  toastRoot.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastRoot.classList.remove('show'), 3600);
}
function brand() { return `<a class="brand" href="/"><span class="brand-mark">+</span><span>TuTurno<span class="brand-dot">.</span></span></a>`; }
function header(admin = false) {
  return `<header class="topbar">${brand()}<nav class="toplinks" aria-label="Navegación principal">${admin ? '<a href="/">Inicio</a>' : '<a class="hide-mobile" href="#como-funciona">Cómo funciona</a><a class="hide-mobile" href="#beneficios">Beneficios</a>'}<a class="button small" href="/admin">${admin ? 'Panel del negocio' : 'Soy dueño de un negocio'}</a></nav></header>`;
}
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (currentUser) headers.set('Authorization', `Bearer ${await currentUser.getIdToken()}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Algo salió mal. Intenta nuevamente.');
  return data;
}

function renderHome() {
  appRoot.innerHTML = `${header()}<main>
    <section class="hero">
      <div><span class="eyebrow"><i></i> Tu negocio, a tu ritmo</span><h1>Reservas simples.<br><span class="gradient-text">Tu negocio en orden.</span></h1><p class="hero-copy">Deja atrás los mensajes cruzados. Comparte tu enlace de reservas, organiza tus espacios y confirma cada turno desde un solo lugar.</p><div class="hero-cta"><a class="button" href="/admin">Empieza gratis <span aria-hidden="true">→</span></a><a class="button secondary" href="#como-funciona">Conoce cómo funciona</a></div><p class="trust">Para canchas, consultorios, salones, barberías y más.</p></div>
      <div class="preview-wrap"><div class="preview-card"><div class="preview-head"><div><strong>Cancha Norte</strong><div class="preview-date">Disponibilidad de la semana</div></div><span class="live-badge">● EN VIVO</span></div><div class="week"><div>LU<b>06</b></div><div>MA<b>07</b></div><div class="selected">MI<b>08</b></div><div>JU<b>09</b></div><div>VI<b>10</b></div><div>SÁ<b>11</b></div><div>DO<b>12</b></div></div><div class="preview-slots"><span class="available">08:00</span><span>09:00</span><span class="taken">10:00</span><span class="available">11:00</span><span class="available">12:00</span><span>13:00</span><span class="taken">14:00</span><span class="available">15:00</span><span>16:00</span></div><div class="preview-foot"><span><i class="legend-dot"></i>Disponible</span><span><i class="legend-dot wait"></i>Pendiente</span><span><i class="legend-dot busy"></i>Ocupado</span></div></div><div class="float-note"><b>¡Solicitud recibida!</b>Una nueva reserva está en camino.</div></div>
    </section>
    <section class="section" id="como-funciona"><div class="section-heading"><span class="eyebrow">Así de fácil</span><h2>Menos coordinación.<br><span class="gradient-text">Más tiempo para tu negocio.</span></h2><p>Tus clientes reservan desde su celular y tú mantienes el control de cada horario.</p></div><div class="feature-grid"><article class="feature"><div class="feature-icon">↗</div><h3>Un enlace para compartir</h3><p>Tu página de reservas personalizada queda lista para enviar por WhatsApp, redes o donde te encuentren.</p></article><article class="feature"><div class="feature-icon">▦</div><h3>Horarios siempre claros</h3><p>Configura tus espacios, días, tarifas y duración. Los turnos solicitados dejan de aparecer como libres.</p></article><article class="feature"><div class="feature-icon">✓</div><h3>Apruebas con confianza</h3><p>Revisa el comprobante, contacta al cliente y confirma o rechaza cada solicitud desde tu panel.</p></article></div></section>
    <section class="section" id="beneficios" style="padding-top:0"><div class="section-heading"><h2>Una agenda que trabaja <span class="gradient-text">contigo.</span></h2><p>Sin registro para tus clientes. Sin enredos para ti. Comparte tu link y recibe solicitudes organizadas en un solo panel.</p><a class="button" href="/admin">Configura tu negocio</a></div></section>
  </main><footer class="footer"><span>© ${new Date().getFullYear()} TuTurno</span><span>Reservar bien se siente bien.</span></footer>`;
}

function bookingDateLabel(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('es-PE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(year, month - 1, day));
}
function makeSlots(data, date, busy) {
  const [openH, openM] = (data.horarioApertura || '08:00').split(':').map(Number);
  const [closeH, closeM] = (data.horarioCierre || '22:00').split(':').map(Number);
  const start = openH * 60 + openM;
  const close = closeH * 60 + closeM;
  const duration = Number(data.duracionMinutos || 60);
  const now = new Date();
  const nowLabel = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const nowMins = nowLabel.split(':').map(Number).reduce((h, m) => h * 60 + m, 0);
  const dayNumber = new Date(`${date}T12:00:00-05:00`).getDay();
  const isOpen = (data.diasAtencion || [0,1,2,3,4,5,6]).includes(dayNumber);
  const occupied = new Map(busy.map(item => [item.horaInicio, item.estado]));
  if (!isOpen) return '<div class="empty-state">Este negocio no atiende ese día. Prueba otra fecha.</div>';
  const output = [];
  for (let minute = start; minute + duration <= close; minute += duration) {
    const hour = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const state = occupied.get(hour) || (date === today() && minute <= nowMins ? 'passed' : 'disponible');
    const cls = state === 'pendiente' ? 'pending' : state === 'aprobado' ? 'busy' : state === 'passed' ? 'busy' : '';
    const label = state === 'pendiente' ? 'Pendiente' : state === 'aprobado' || state === 'passed' ? 'Ocupado' : hour;
    output.push(`<button class="slot ${cls}" type="button" data-time="${hour}" ${cls ? 'disabled' : ''} aria-label="${hour} ${label}">${label}</button>`);
  }
  return output.length ? output.join('') : '<div class="empty-state">No hay turnos configurados para esta fecha.</div>';
}

async function renderBooking(slug) {
  appRoot.innerHTML = `${header()}<main class="narrow"><div class="booking-card"><div class="boot"><span class="spinner"></span><span>Cargando horarios...</span></div></div></main>`;
  try {
    const data = await api(`/api/negocio/${encodeURIComponent(slug)}`);
    const date = today();
    const firstResource = data.recursos?.[0]?.id || '';
    appRoot.innerHTML = `${header()}<main class="narrow"><section class="booking-card"><div class="booking-intro"><div><span class="eyebrow"><i></i> Reserva en línea</span><h1>${esc(data.nombre)}</h1><p>Elige un espacio y horario disponible. Tu solicitud quedará pendiente hasta que el negocio la confirme.</p></div><div class="booking-logo">${esc((data.nombre || 'T')[0].toUpperCase())}</div></div>
      <div class="field-row"><div class="field"><label for="book-date">Fecha</label><input id="book-date" type="date" min="${today()}" value="${date}"></div><div class="field"><label>Duración</label><div class="notice">Bloques de ${Number(data.duracionMinutos || 60)} minutos</div></div></div>
      <div class="day-title"><h3>Elige un espacio</h3><span id="resource-hint"></span></div><div class="resource-list" id="resource-list">${(data.recursos || []).map((item, i) => `<button class="chip ${i === 0 ? 'active' : ''}" data-resource="${esc(item.id)}" type="button">${esc(item.nombre)}</button>`).join('') || '<span class="muted">El negocio aún no configuró espacios.</span>'}</div>
      <div class="day-title"><h3>Horarios disponibles</h3><span id="selected-date-label">${esc(bookingDateLabel(date))}</span></div><div class="slots" id="slots"><div class="empty-state">Consultando disponibilidad...</div></div>
      <div id="reservation-form-wrap"></div>
    </section><p class="help-copy" style="text-align:center;margin-top:18px">Tu solicitud se envía al negocio para confirmación. El envío del formulario no garantiza una reserva hasta que sea aprobada.</p></main><footer class="footer"><span>Agenda con tecnología de TuTurno</span><a href="/">Conoce TuTurno</a></footer>`;
    if (!firstResource) return;
    let selectedResource = firstResource;
    let selectedTime = '';
    let availabilityAbort;
    async function refreshAvailability() {
      const chosenDate = $('#book-date').value;
      $('#selected-date-label').textContent = bookingDateLabel(chosenDate);
      $('#reservation-form-wrap').innerHTML = '';
      selectedTime = '';
      $('#slots').innerHTML = '<div class="empty-state"><span class="spinner"></span> Consultando disponibilidad...</div>';
      if (availabilityAbort) availabilityAbort.abort();
      availabilityAbort = new AbortController();
      try {
        const response = await fetch(`/api/negocio/${encodeURIComponent(slug)}/disponibilidad?fecha=${encodeURIComponent(chosenDate)}&recursoId=${encodeURIComponent(selectedResource)}`, { signal: availabilityAbort.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'No se pudo consultar el horario.');
        $('#slots').innerHTML = makeSlots(data, chosenDate, result.reservas || []);
      } catch (error) {
        if (error.name !== 'AbortError') $('#slots').innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
      }
    }
    function showReservationForm(time) {
      selectedTime = time;
      $$('.slot').forEach(button => button.classList.toggle('selected', button.dataset.time === time));
      const start = Number(time.slice(0,2))*60 + Number(time.slice(3));
      const specialStart = data.horaInicioEspecial ? Number(data.horaInicioEspecial.slice(0,2))*60 + Number(data.horaInicioEspecial.slice(3)) : -1;
      const specialEnd = data.horaFinEspecial ? Number(data.horaFinEspecial.slice(0,2))*60 + Number(data.horaFinEspecial.slice(3)) : -1;
      const hourly = Number(data.precioHoraEspecial || 0) > 0 && start >= specialStart && start < specialEnd ? Number(data.precioHoraEspecial) : Number(data.precioHoraEstandar || 0);
      const amount = hourly * Number(data.duracionMinutos || 60) / 60;
      $('#reservation-form-wrap').innerHTML = `<div class="separator"></div><div class="day-title"><h3>Completa tu solicitud</h3><span>${esc(time)} · ${money(amount)}</span></div>
        <div class="price-line"><span>${esc(data.nombre)} · ${Number(data.duracionMinutos || 60)} min</span><strong>${money(amount)}</strong></div>
        ${data.qrYapeUrl ? `<div class="panel-card" style="text-align:center"><strong>Escanea para pagar con Yape o Plin</strong><br><img class="qr-preview" src="${esc(data.qrYapeUrl)}" alt="Código QR de pago de ${esc(data.nombre)}"><p class="help-copy">Adjunta el comprobante en el siguiente formulario.</p></div>` : '<div class="notice">El negocio te compartirá los datos de pago al revisar la solicitud.</div>'}
        <form id="reservation-form"><div class="field-row"><div class="field"><label for="client-name">Nombre completo</label><input id="client-name" name="clienteNombre" autocomplete="name" minlength="2" maxlength="100" required placeholder="Tu nombre"></div><div class="field"><label for="client-phone">Teléfono / WhatsApp</label><input id="client-phone" name="clienteTelefono" type="tel" inputmode="tel" autocomplete="tel" minlength="8" maxlength="16" required placeholder="Ej. 51999123456"></div></div><div class="field"><label for="proof">Comprobante de pago</label><input id="proof" name="comprobante" type="file" accept="image/jpeg,image/png,image/webp" required><p class="field-hint">Imagen JPG, PNG o WebP · máximo 8 MB.</p></div><div id="booking-message"></div><button class="button full" type="submit">Enviar solicitud de reserva <span>→</span></button><p class="help-copy" style="margin:10px 0 0">Al enviar, autorizas al negocio a contactarte sobre esta reserva.</p></form>`;
      $('#reservation-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('button[type="submit"]', event.currentTarget);
        button.disabled = true;
        button.textContent = 'Enviando solicitud…';
        const formData = new FormData(event.currentTarget);
        formData.set('slug', slug);
        formData.set('recursoId', selectedResource);
        formData.set('fecha', $('#book-date').value);
        formData.set('horaInicio', selectedTime);
        try {
          const result = await api('/api/reserva', { method: 'POST', body: formData });
          $('#reservation-form-wrap').innerHTML = `<div class="separator"></div><div class="notice"><strong>Solicitud enviada.</strong><br>${esc(result.message)}<br>Espacio: ${esc(data.recursos.find(item => item.id === selectedResource)?.nombre || '')} · ${esc($('#book-date').value)} · ${esc(time)}.</div>${result.whatsappUrl ? `<a class="button full" style="margin-top:14px" target="_blank" rel="noopener noreferrer" href="${esc(result.whatsappUrl)}">Avisar al negocio por WhatsApp ↗</a>` : ''}`;
          await refreshAvailability();
          $('#reservation-form-wrap').innerHTML = `<div class="separator"></div><div class="notice"><strong>Solicitud enviada.</strong><br>${esc(result.message)}<br>Espacio: ${esc(data.recursos.find(item => item.id === selectedResource)?.nombre || '')} · ${esc($('#book-date').value)} · ${esc(time)}.</div>${result.whatsappUrl ? `<a class="button full" style="margin-top:14px" target="_blank" rel="noopener noreferrer" href="${esc(result.whatsappUrl)}">Avisar al negocio por WhatsApp ↗</a>` : ''}`;
        } catch (error) {
          $('#booking-message').innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
          button.disabled = false;
          button.innerHTML = 'Enviar solicitud de reserva <span>→</span>';
        }
      });
    }
    $('#resource-list').addEventListener('click', event => {
      const button = event.target.closest('[data-resource]');
      if (!button) return;
      selectedResource = button.dataset.resource;
      $$('.chip').forEach(chip => chip.classList.toggle('active', chip === button));
      refreshAvailability();
    });
    $('#slots').addEventListener('click', event => {
      const button = event.target.closest('[data-time]');
      if (button && !button.disabled) showReservationForm(button.dataset.time);
    });
    $('#book-date').addEventListener('change', refreshAvailability);
    refreshAvailability();
    const availabilityTimer = setInterval(() => {
      if (!selectedTime && document.visibilityState === 'visible') refreshAvailability();
    }, 15000);
    window.addEventListener('pagehide', () => clearInterval(availabilityTimer), { once: true });
  } catch (error) {
    appRoot.innerHTML = `${header()}<main class="narrow"><div class="booking-card"><div class="error-box">${esc(error.message)}</div><p style="margin-top:20px"><a class="button secondary" href="/">Ir al inicio</a></p></div></main>`;
  }
}

function loginMarkup() {
  return `${header(true)}<main class="auth-wrap"><section class="auth-card panel-card"><span class="eyebrow"><i></i> Espacio para negocios</span><h1>Bienvenido a TuTurno</h1><p>Inicia sesión para administrar tus espacios y confirmar solicitudes. ¿Aún no tienes cuenta? Regístrate aquí.</p><button id="google-login" class="button secondary full" type="button">Continuar con Google</button><div class="auth-divider">O con tu correo electrónico</div><form id="login-form"><div class="field"><label for="email">Correo electrónico</label><input id="email" type="email" autocomplete="email" required placeholder="tu@negocio.com"></div><div class="field"><label for="password">Contraseña</label><input id="password" type="password" autocomplete="current-password" minlength="6" required placeholder="Al menos 6 caracteres"></div><div id="auth-error"></div><button class="button full" type="submit">Iniciar sesión</button></form><div class="inline-actions"><button class="inline-link" id="register-button" type="button">Crear cuenta gratis</button><button class="inline-link" id="forgot-button" type="button">Olvidé mi contraseña</button></div><p class="help-copy">Tu cuenta de Firebase Authentication mantiene protegido el panel del negocio.</p></section></main>`;
}
async function renderLogin() {
  appRoot.innerHTML = loginMarkup();
  $('#google-login').addEventListener('click', async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (error) { authError(error); }
  });
  $('#login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = $('#email').value.trim(); const password = $('#password').value;
    try { await signInWithEmailAndPassword(auth, email, password); } catch (error) { authError(error); }
  });
  $('#register-button').addEventListener('click', async () => {
    const email = $('#email').value.trim(); const password = $('#password').value;
    if (!email || password.length < 6) return showAuthError('Escribe tu correo y una contraseña de al menos 6 caracteres para crear la cuenta.');
    try { await createUserWithEmailAndPassword(auth, email, password); } catch (error) { authError(error); }
  });
  $('#forgot-button').addEventListener('click', async () => {
    const email = $('#email').value.trim();
    if (!email) return showAuthError('Escribe tu correo electrónico primero.');
    try { await sendPasswordResetEmail(auth, email); notify('Te enviamos un enlace para restablecer tu contraseña.'); } catch (error) { authError(error); }
  });
}
function showAuthError(message) { const target = $('#auth-error'); if (target) target.innerHTML = `<div class="error-box">${esc(message)}</div>`; }
function authError(error) {
  const messages = { 'auth/invalid-credential':'Correo o contraseña incorrectos.', 'auth/email-already-in-use':'Este correo ya tiene una cuenta.', 'auth/weak-password':'Usa una contraseña de al menos 6 caracteres.', 'auth/invalid-email':'Escribe un correo válido.', 'auth/popup-closed-by-user':'Se cerró la ventana de inicio de sesión.' };
  showAuthError(messages[error.code] || error.message || 'No se pudo iniciar sesión.');
}
function field(name, label, value, attrs = '') { return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" value="${esc(value ?? '')}" ${attrs}></div>`; }
function settingsFields(data = {}, setup = false) {
  const days = (data.diasAtencion || [0,1,2,3,4,5,6]).map(Number);
  return `${setup ? field('business-slug','Enlace corto de reservas',data.slug || '', 'required minlength="3" maxlength="40" placeholder="mi-negocio"') : ''}
    <div class="field-row">${field('business-name','Nombre del negocio',data.nombre || '', 'required maxlength="80" placeholder="Ej. Canchas El Parque"')}${field('business-phone','WhatsApp del negocio',data.telefonoWhatsapp || '', 'required type="tel" placeholder="51999111222"')}</div>
    <div class="field-row">${field('business-open','Hora de apertura',data.horarioApertura || '08:00','required type="time"')}${field('business-close','Hora de cierre',data.horarioCierre || '22:00','required type="time"')}</div>
    <div class="field-row">${field('business-price','Precio por hora (S/)',data.precioHoraEstandar ?? 0,'required type="number" min="0" step="0.01"')}${field('business-duration','Duración del turno (minutos)',data.duracionMinutos || 60,'required type="number" min="15" max="480" step="15"')}</div>
    <div class="field-row">${field('special-price','Precio especial por hora (opcional)',data.precioHoraEspecial || 0,'type="number" min="0" step="0.01"')}${field('special-start','Inicio de tarifa especial',data.horaInicioEspecial || '20:00','type="time"')}</div>
    ${field('special-end','Fin de tarifa especial',data.horaFinEspecial || '23:00','type="time"')}
    <div class="field"><label for="business-resources">Espacios o recursos (uno por línea)</label><textarea id="business-resources" rows="4" placeholder="Cancha 1&#10;Cancha 2">${esc((data.recursos || []).map(resource => resource.nombre).join('\n'))}</textarea><p class="field-hint">Ejemplos: Cancha 1, Sillón 2, Consultorio principal.</p></div>
    <div class="field"><label>Días de atención</label><div class="days-check">${weekNames.map((day, index) => `<label class="day-check"><input type="checkbox" name="business-days" value="${index}" ${days.includes(index) ? 'checked' : ''}>${weekShort[index]}</label>`).join('')}</div></div>`;
}
function formBusinessData(isSetup) {
  const recursos = $('#business-resources').value.split('\n').map(name => name.trim()).filter(Boolean);
  const data = {
    nombre: $('#business-name').value.trim(), telefonoWhatsapp: $('#business-phone').value.trim(), horarioApertura: $('#business-open').value,
    horarioCierre: $('#business-close').value, precioHoraEstandar: Number($('#business-price').value), duracionMinutos: Number($('#business-duration').value),
    precioHoraEspecial: Number($('#special-price').value || 0), horaInicioEspecial: $('#special-start').value, horaFinEspecial: $('#special-end').value,
    recursos, diasAtencion: $$('input[name="business-days"]:checked').map(input => Number(input.value))
  };
  if (isSetup) data.slug = $('#business-slug').value.trim();
  return data;
}
function setupView() {
  return `${header(true)}<main class="app-shell"><div class="dashboard-head"><div><span class="eyebrow"><i></i> Primer paso</span><h1>Configura tu negocio</h1><p class="muted">Crea tu enlace de reservas y ajusta tus horarios.</p></div><button id="logout" class="button ghost">Cerrar sesión</button></div><section class="panel-card"><h2>Información y disponibilidad</h2><form id="business-form">${settingsFields({}, true)}<div id="business-error"></div><button class="button" type="submit">Crear mi página de reservas →</button></form></section></main>`;
}
function tabNavigation() {
  return `<div class="tabs" role="tablist"><button class="tab ${activeTab === 'reservas' ? 'active' : ''}" data-tab="reservas">Reservas</button><button class="tab ${activeTab === 'ajustes' ? 'active' : ''}" data-tab="ajustes">Ajustes del local</button><button class="tab ${activeTab === 'qr' ? 'active' : ''}" data-tab="qr">Mi QR de pago</button></div>`;
}
function reservationCard(item) {
  const state = item.estado || 'pendiente';
  return `<article class="reservation"><div class="reservation-date">${esc(item.fecha)}<b>${esc(item.horaInicio)}–${esc(item.horaFin)}</b></div><div><h3>${esc(item.clienteNombre)} · ${esc(item.recursoNombre || item.recursoId)}</h3><p>WhatsApp: ${esc(item.clienteTelefono)} · ${money(item.monto)}</p><div class="reservation-actions">${item.voucherUrl ? `<a class="button secondary small" href="${esc(item.voucherUrl)}" target="_blank" rel="noopener noreferrer">Ver comprobante ↗</a>` : ''}${state === 'pendiente' ? `<button class="button small" data-state="aprobado" data-id="${esc(item.id)}">Aprobar</button><button class="button danger small" data-state="rechazado" data-id="${esc(item.id)}">Rechazar</button>` : ''}</div></div><span class="status ${esc(state)}">${state === 'pendiente' ? 'Pendiente' : state === 'aprobado' ? 'Aprobada' : 'Rechazada'}</span></article>`;
}
function reservationsView() {
  const pending = reservations.filter(item => item.estado === 'pendiente').length;
  const todayCount = reservations.filter(item => item.fecha === today() && item.estado !== 'rechazado').length;
  const approved = reservations.filter(item => item.estado === 'aprobado').length;
  const list = reservations.filter(item => item.estado !== 'rechazado').sort((a,b) => `${a.fecha} ${a.horaInicio}`.localeCompare(`${b.fecha} ${b.horaInicio}`));
  const shareUrl = `${location.origin}/reservar/${business.slug || business.id}`;
  return `<div class="stats"><div class="stat"><span>Reservas para hoy</span><strong>${todayCount}</strong></div><div class="stat"><span>Solicitudes pendientes</span><strong>${pending}</strong></div><div class="stat"><span>Turnos confirmados</span><strong>${approved}</strong></div></div>
    <section class="panel-card"><h2>Comparte tu enlace de reservas</h2><div class="share-box"><input id="share-link" readonly value="${esc(shareUrl)}"><button class="button small" id="copy-link">Copiar enlace</button><a class="button secondary small" target="_blank" rel="noopener noreferrer" href="${esc(shareUrl)}">Ver página ↗</a></div></section>
    <section class="panel-card"><div class="day-title"><h2>Solicitudes y reservas</h2><button class="button ghost small" id="refresh-reservations">Actualizar</button></div><div class="reservation-list">${list.map(reservationCard).join('') || '<div class="empty-state">Todavía no tienes reservas. Comparte tu enlace para empezar.</div>'}</div></section>`;
}
function settingsView() {
  return `<section class="panel-card"><h2>Perfil y horarios</h2><p class="help-copy">Administra cómo aparece tu página pública. Tu enlace corto no se puede cambiar después de creado.</p><form id="business-form">${settingsFields(business, false)}<div id="business-error"></div><button class="button" type="submit">Guardar cambios</button></form></section>`;
}
function qrView() {
  return `<section class="panel-card"><h2>Código de pago Yape o Plin</h2><p class="help-copy">El QR aparecerá a tus clientes antes de enviar el comprobante. Verifica el importe y el titular antes de aprobar cada reserva.</p>${business.qrYapeUrl ? `<img class="qr-preview" src="${esc(business.qrYapeUrl)}" alt="QR de pago actual">` : '<div class="notice">Aún no has cargado un QR de pago.</div>'}<form id="qr-form"><div class="field"><label for="qr-file">Subir imagen QR</label><input type="file" id="qr-file" accept="image/jpeg,image/png,image/webp" required><p class="field-hint">JPG, PNG o WebP · máximo 8 MB.</p></div><div id="qr-error"></div><button class="button" type="submit">${business.qrYapeUrl ? 'Reemplazar QR' : 'Guardar QR'}</button></form></section>`;
}
function dashboardView() {
  const content = activeTab === 'ajustes' ? settingsView() : activeTab === 'qr' ? qrView() : reservationsView();
  return `${header(true)}<main class="app-shell"><div class="dashboard-head"><div><span class="eyebrow"><i></i> Panel de negocio</span><h1>Hola, ${esc((business.nombre || 'negocio').split(' ')[0])}</h1><p class="muted">Gestiona turnos de <strong>${esc(business.nombre)}</strong></p></div><button id="logout" class="button ghost">Cerrar sesión</button></div>${tabNavigation()}<div id="dashboard-content">${content}</div></main>`;
}
async function renderDashboard() {
  clearInterval(dashboardRefreshTimer);
  appRoot.innerHTML = `${header(true)}<main class="app-shell"><div class="panel-card"><span class="spinner"></span> Cargando tu espacio...</div></main>`;
  try {
    const result = await api('/api/admin/negocio');
    business = result.negocio;
    if (!business) { appRoot.innerHTML = setupView(); wireLogout(); wireBusinessForm(true); return; }
    try { reservations = (await api('/api/admin/reservas')).reservas || []; } catch (error) { notify(error.message, true); }
    appRoot.innerHTML = dashboardView();
    wireDashboard();
  } catch (error) {
    appRoot.innerHTML = `${header(true)}<main class="app-shell"><div class="error-box">${esc(error.message)} <button class="button secondary small" id="reload-dashboard">Reintentar</button></div></main>`;
    $('#reload-dashboard')?.addEventListener('click', renderDashboard);
  }
}
function wireLogout() { $('#logout')?.addEventListener('click', () => signOut(auth)); }
function wireBusinessForm(isSetup) {
  $('#business-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', event.currentTarget); button.disabled = true; button.textContent = 'Guardando…';
    try {
      const payload = formBusinessData(isSetup);
      const result = await api('/api/admin/negocio', { method: isSetup ? 'POST' : 'PUT', body: JSON.stringify(payload) });
      business = result.negocio;
      notify(isSetup ? 'Tu página de reservas está lista.' : 'Ajustes actualizados.');
      activeTab = 'reservas';
      await renderDashboard();
    } catch (error) {
      const target = $('#business-error'); if (target) target.innerHTML = `<div class="error-box">${esc(error.message)}</div>`;
      button.disabled = false; button.textContent = isSetup ? 'Crear mi página de reservas →' : 'Guardar cambios';
    }
  });
}
function wireDashboard() {
  wireLogout();
  $$('.tab').forEach(button => button.addEventListener('click', () => {
    activeTab = button.dataset.tab;
    const content = $('#dashboard-content');
    content.innerHTML = activeTab === 'ajustes' ? settingsView() : activeTab === 'qr' ? qrView() : reservationsView();
    wireTabContent();
    $$('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === activeTab));
  }));
  wireTabContent();
  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer = setInterval(async () => {
    if (activeTab !== 'reservas' || document.visibilityState !== 'visible') return;
    try {
      const next = (await api('/api/admin/reservas')).reservas || [];
      if (JSON.stringify(next) !== JSON.stringify(reservations)) {
        reservations = next;
        const content = $('#dashboard-content');
        if (content && activeTab === 'reservas') { content.innerHTML = reservationsView(); wireTabContent(); }
      }
    } catch { /* El botón Actualizar permite reintentar sin interrumpir la sesión. */ }
  }, 20000);
}
function wireTabContent() {
  wireBusinessForm(false);
  $('#copy-link')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#share-link').value); notify('Enlace copiado.'); }
    catch { $('#share-link').select(); document.execCommand('copy'); notify('Enlace copiado.'); }
  });
  $('#refresh-reservations')?.addEventListener('click', async event => {
    const button = event.currentTarget; button.disabled = true;
    try { reservations = (await api('/api/admin/reservas')).reservas || []; $('#dashboard-content').innerHTML = reservationsView(); wireTabContent(); }
    catch (error) { notify(error.message, true); button.disabled = false; }
  });
  $$('.reservation-actions [data-state]').forEach(button => button.addEventListener('click', async () => {
    const decision = button.dataset.state === 'aprobado' ? 'aprobar' : 'rechazar';
    if (decision === 'rechazar' && !window.confirm('¿Quieres rechazar esta solicitud y liberar el horario?')) return;
    button.disabled = true;
    try {
      await api(`/api/admin/reserva/${encodeURIComponent(button.dataset.id)}/estado`, { method: 'PUT', body: JSON.stringify({ estado: button.dataset.state }) });
      reservations = (await api('/api/admin/reservas')).reservas || [];
      $('#dashboard-content').innerHTML = reservationsView(); wireTabContent(); notify(decision === 'aprobar' ? 'Reserva confirmada.' : 'Solicitud rechazada y horario liberado.');
    } catch (error) { notify(error.message, true); button.disabled = false; }
  }));
  $('#qr-form')?.addEventListener('submit', async event => {
    event.preventDefault(); const button = $('button[type="submit"]', event.currentTarget); button.disabled = true; button.textContent = 'Subiendo imagen…';
    const formData = new FormData(); formData.set('qr', $('#qr-file').files[0]);
    try { await api('/api/admin/negocio/qr', { method: 'POST', body: formData }); business = { ...business, qrYapeUrl: (await api('/api/admin/negocio')).negocio.qrYapeUrl }; notify('QR actualizado.'); $('#dashboard-content').innerHTML = qrView(); wireTabContent(); }
    catch (error) { $('#qr-error').innerHTML = `<div class="error-box">${esc(error.message)}</div>`; button.disabled = false; button.textContent = 'Guardar QR'; }
  });
}

async function boot() {
  const path = decodeURI(location.pathname);
  if (path.startsWith('/reservar/')) return renderBooking(path.split('/').filter(Boolean)[1] || '');
  if (!path.startsWith('/admin')) return renderHome();
  try {
    const config = await fetch('/api/config').then(response => response.json());
    const firebase = config.firebase || {};
    if (!firebase.apiKey || !firebase.projectId || !firebase.appId || !firebase.authDomain) {
      appRoot.innerHTML = `${header(true)}<main class="auth-wrap"><section class="auth-card panel-card"><span class="eyebrow">Configuración necesaria</span><h1>Conecta Firebase</h1><p>Para habilitar el panel, completa las variables <code>FIREBASE_API_KEY</code>, <code>FIREBASE_AUTH_DOMAIN</code>, <code>FIREBASE_PROJECT_ID</code> y <code>FIREBASE_APP_ID</code> en tu entorno. Revisa el archivo README para los pasos.</p><a class="button secondary" href="/">Volver al inicio</a></section></main>`;
      return;
    }
    auth = getAuth(initializeApp(firebase));
    onAuthStateChanged(auth, user => { currentUser = user; if (user) renderDashboard(); else renderLogin(); });
  } catch (error) {
    appRoot.innerHTML = `${header(true)}<main class="auth-wrap"><section class="auth-card panel-card"><div class="error-box">No se pudo iniciar Firebase Authentication: ${esc(error.message)}</div></section></main>`;
  }
}
boot();
