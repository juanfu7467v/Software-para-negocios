# 1️⃣ Imagen base estable y ligera de Node.js (Actualizada a v22 para soporte nativo de WebSockets)
FROM node:22-slim

# 2️⃣ Instala dependencias del sistema necesarias para compilar módulos nativos
RUN apt-get update && apt-get install -y \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

# 3️⃣ Define el directorio de trabajo
WORKDIR /app

# 4️⃣ Copia package.json y package-lock.json (si existe)
COPY package*.json ./

# 5️⃣ Instala las dependencias con seguridad
RUN npm install --legacy-peer-deps --no-audit --no-fund

# 6️⃣ Copia el resto de los archivos del proyecto
COPY . .

# 7️⃣ Expone el puerto (usa el mismo que tu servidor, ej. 8080)
EXPOSE 8080

# 8️⃣ Comando de arranque
CMD ["npm", "start"]
