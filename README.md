# TuTurno

TuTurno es una agenda SaaS multinegocio para reservar espacios y servicios por bloques de tiempo. Los clientes reservan desde un enlace público sin crear una cuenta; el negocio configura horarios y precios, recibe comprobantes Yape/Plin y aprueba o rechaza solicitudes desde su panel.

## Funcionalidades

- Página de inicio de TuTurno y enlaces públicos `/reservar/:slug`.
- Disponibilidad por fecha y recurso, diferenciada como disponible, pendiente u ocupada.
- Solicitudes con datos del cliente y carga de comprobantes (JPG, PNG, WebP, máximo 8 MB).
- Reserva atómica en Firestore: una transacción evita duplicados por recurso, fecha y hora.
- Acceso de administradores mediante Firebase Authentication (correo/contraseña o Google); el API valida ID tokens y filtra los datos por propietario.
- Panel para revisar comprobantes, aprobar/rechazar solicitudes, copiar el enlace, modificar horarios/tarifas/recursos y cargar el QR del negocio.
- Firebase Storage para imágenes y Fly.io configurado con auto-stop/auto-start y cero máquinas mínimas.

## Requisitos

- Node.js 22 o posterior.
- Proyecto Firebase con Authentication (proveedores Email/Password y/o Google), Firestore y Storage habilitados.
- Bucket de Firebase Storage y cuenta de servicio para Firebase Admin.

## Desarrollo local

```bash
cp .env.example .env
# Completa .env con los valores de Firebase Web, el bucket y Firebase Admin.
npm install
npm run check
npm run dev
```

Abrir `http://localhost:8080`. `/api/health` reporta el estado del servidor, Firebase Admin y Storage. Si no se han configurado credenciales, la portada sigue disponible, pero las APIs de datos informan que Firebase debe configurarse.

### Variables de entorno

Valores de Firebase Web (API key, auth domain, project ID y app ID) son identificadores públicos del cliente. Las credenciales de Firebase Admin son secretos: **no** se guardan en el repositorio ni se envían al navegador.

| Variable | Uso |
| --- | --- |
| `FIREBASE_API_KEY` | SDK web de Firebase Authentication |
| `FIREBASE_AUTH_DOMAIN` | Dominio de autenticación del proyecto |
| `FIREBASE_PROJECT_ID` | Proyecto Firestore y credencial Admin |
| `FIREBASE_APP_ID` | Aplicación web de Firebase |
| `FIREBASE_STORAGE_BUCKET` | Bucket para QR y comprobantes |
| `FIREBASE_SERVICE_ACCOUNT` | JSON completo de cuenta de servicio en una sola línea (preferido en Fly secrets) |
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Alternativa de cuenta de servicio por variables |
| `PORT` | Puerto HTTP (8080 por defecto) |
| `TZ` | Zona horaria usada para validar turnos (`America/Lima` por defecto) |

En Firebase Console, añade el dominio de la aplicación a **Authentication → Settings → Authorized domains** y activa los proveedores que ofrecerás. Para Google en desarrollo local, añade `localhost` si Firebase no lo ha incluido.

## Modelo de datos

- `negocios/{slug}`: propietario, nombre, WhatsApp, recursos, calendario semanal, horarios, precios y URL del QR.
- `reservas/{recursoId_fecha_hora}`: negocio, recurso, cliente, bloque solicitado, importe, URL del comprobante y estado (`pendiente`, `aprobado` o `rechazado`).
- Los comprobantes y QR se guardan en `negocios/{slug}/comprobantes/` y `negocios/{slug}/qr/` en Storage. El servidor crea enlaces de descarga con token aleatorio.

El API usa Firebase Admin y hace todas las validaciones de propiedad en servidor. Los archivos `firestore.rules` y `storage.rules` deniegan el acceso directo del cliente; mantenerlos así si los datos se operan exclusivamente a través de este backend.

## API principal

- `GET /api/health` — estado de servidor e integraciones.
- `GET /api/config` — configuración pública de Firebase para el navegador.
- `GET /api/negocio/:slug` — datos públicos del negocio.
- `GET /api/negocio/:slug/disponibilidad?fecha=YYYY-MM-DD&recursoId=...` — horarios ocupados.
- `POST /api/reserva` — multipart con `slug`, `recursoId`, `fecha`, `horaInicio`, `clienteNombre`, `clienteTelefono` y `comprobante`.
- `GET /api/admin/negocio` y `POST/PUT /api/admin/negocio` — datos propios del negocio (Firebase ID token requerido).
- `POST /api/admin/negocio/qr` — carga del QR (autenticado).
- `GET /api/admin/reservas` — solicitudes del propietario autenticado.
- `PUT /api/admin/reserva/:id/estado` — `{ "estado": "aprobado" | "rechazado" }` (autenticado).

Los turnos se crean como `pendiente` para que el dueño pueda comprobar manualmente el pago antes de confirmarlos. Se limita el endpoint público de reservas a 12 solicitudes cada 10 minutos por IP. El tiempo de turno y horario se valida nuevamente en el servidor.

## Despliegue en Fly.io

El `Dockerfile` sirve la aplicación en `0.0.0.0:8080`; `fly.toml` define health check, HTTPS, auto-start y escala a cero cuando no hay tráfico. Cambia `app = 'tuturno'` por el nombre único de tu aplicación si ya está ocupado y selecciona una región soportada cercana en `primary_region`.

```bash
fly launch --no-deploy
fly secrets set \
  FIREBASE_API_KEY='...' \
  FIREBASE_AUTH_DOMAIN='tu-proyecto.firebaseapp.com' \
  FIREBASE_PROJECT_ID='tu-proyecto' \
  FIREBASE_APP_ID='1:...:web:...' \
  FIREBASE_STORAGE_BUCKET='tu-proyecto.firebasestorage.app' \
  FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
fly deploy
```

Usa `fly secrets set` para la cuenta de servicio y no incluyas claves privadas en `fly.toml`, commits o logs. Configura el dominio Fly en la lista de dominios autorizados de Firebase Authentication después del despliegue.

## Verificación

```bash
npm run check
npm start
curl http://localhost:8080/api/health
```

La verificación end-to-end de autenticación, Storage y transacciones requiere credenciales y servicios reales de Firebase, que se aportan al entorno de despliegue y no forman parte del repositorio.
