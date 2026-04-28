# Imagen base oficial de Node.js v24 sobre Alpine Linux.
# Alpine es minimalista (~50MB vs ~350MB de la imagen full) y reduce superficie de ataque.
FROM node:24-alpine

# Directorio de trabajo dentro del contenedor.
WORKDIR /app

# Copiamos primero solo los manifiestos de dependencias para aprovechar
# el cache de capas. Si package.json no cambia entre builds, npm ci no se reejecuta.
COPY package*.json ./

# npm ci es más rápido y reproducible que npm install (instala desde el lock file
# exacto). --omit=dev excluye devDependencies (no las hay aquí, pero por convención).
RUN npm ci --omit=dev

# Copiamos el código fuente. El .dockerignore filtra lo que NO debe entrar.
COPY src ./src

# Creamos el directorio de logs y damos ownership al usuario 'node' (UID 1000),
# que viene predefinido en las imágenes oficiales de Node.
RUN mkdir -p /app/logs && chown -R node:node /app

# Cambiamos al usuario no-root. Si la app es comprometida, el atacante
# no tiene privilegios de root dentro del contenedor.
USER node

# Documentación: la app escucha en el puerto 3000.
# El binding real al host se define en docker-compose.yml.
EXPOSE 3000

# Comando de arranque. Forma exec (array) para que Node reciba señales
# del sistema directamente (SIGTERM, SIGINT) y pueda hacer shutdown limpio.
CMD ["node", "src/server.js"]
