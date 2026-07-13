# --- Stage 1: build the React frontend ------------------------------------ #
FROM node:20-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# Same-origin deploy: no VITE_API_BASE, so the app uses relative URLs.
RUN npm run build

# --- Stage 2: python backend that serves the built frontend --------------- #
FROM python:3.12-slim AS backend
WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY --from=frontend /app/frontend/dist ./frontend/dist

# Serve the built SPA from the backend, and persist SQLite under /var/data.
ENV FRONTEND_DIST=/app/frontend/dist \
    DB_PATH=/var/data/apex.db \
    PORT=8000
RUN mkdir -p /var/data

EXPOSE 8000
# Platforms inject $PORT; default to 8000 locally.
CMD ["sh", "-c", "cd backend && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
