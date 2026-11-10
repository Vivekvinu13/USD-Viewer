# One container serves the website and the USD converter API.
FROM node:22-slim AS web
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server ./server
COPY --from=web /app/dist ./dist
ENV PORT=8000
RUN useradd --system --create-home viewer
# do not run as root
USER viewer
WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:%s/api/health'%os.environ.get('PORT','8000'))"
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
