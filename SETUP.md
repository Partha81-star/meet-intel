# MeetIntel full-stack setup

The project has a Next.js browser frontend, a FastAPI API and WebSocket backend,
and durable meeting storage. SQLite runs locally without a separate service;
Docker runs PostgreSQL. Electron remains available for desktop system audio and
screen capture. The app is a **single shared workspace**, with one recording at a
time. The Docker gateway requires a password; it is not a multi-tenant service.

## Run on this Windows machine

Python 3.12 and Node 22 or newer are required.

```powershell
npm run setup
npm run dev
```

Open http://localhost:3000. Choose a title and participants, start a session,
watch the synthetic transcript and task arrive, and stop to see the debrief.
Meeting history and task completion/deletion survive backend restarts.
Demo mode does not request microphone permission or call AI services.

Source code stays in this repository. Dependencies and frontend builds are kept
under `%LOCALAPPDATA%\MeetIntel\runtime` so an external drive does not slow down
installation. The dev launcher mirrors source changes into that runtime. Restart
the launcher after changing configuration or environment files.

For Electron, run `scripts/setup.ps1 -Desktop`, then `scripts/start.ps1 -Desktop`.
`npm run build` creates an Electron installer with exported frontend assets.
The Python backend must run separately; the installer does not bundle Python.
`npm run build:web` checks the standalone web build.

## Enable real transcription and AI

Edit `backend/.env` locally (or root `.env` for Docker):

```dotenv
DEMO_MODE=false
GOOGLE_API_KEY=your-google-ai-studio-key
DEEPGRAM_API_KEY=your-deepgram-key
```

Restart the backend. The dashboard will show Live mode and request microphone
access when recording starts. Browser capture uses the local microphone;
Electron also captures system audio and screen context. Browser microphone APIs
require localhost or HTTPS. Live provider access is not verified without keys.

Gemini model names are configurable, and defaults follow Google's October 2026
[model lifecycle](https://ai.google.dev/gemini-api/docs/deprecations). The supported
`google-genai` SDK replaces the retired `google-generativeai` SDK. Embeddings are
requested at 768 dimensions. If using the optional Supabase semantic debt search,
apply `docs/supabase_schema.sql` and re-embed old vectors when changing models.
Without Supabase, the debt panel lists stored unresolved tasks across meetings.

## Docker on your computer or server

Install Docker Engine and the Compose v2 plugin on a Linux server, or Docker
Desktop locally. Python 3 is required once to generate deployment configuration.
From the repository root:

```bash
python3 deployment/setup.py
docker compose up --build -d --wait
```

Open http://localhost and use the generated login password. This default binds
only to loopback. Keep the password in a password manager and keep `.env` private.
The database and backend have no public ports. PostgreSQL and Caddy certificates
use persistent Docker volumes. A health check waits for each service before
starting the next. Caddy forwards `/api/*`, including WebSockets, to FastAPI.

For internet access you need a server and a DNS name. Point the domain's A record
at your server, allow inbound TCP 80/443, and generate configuration using:

```bash
python3 deployment/setup.py --domain meet.example.com
docker compose up --build -d --wait
```

Run setup once: it refuses to overwrite `.env`. If `.env` already exists, change
`SITE_ADDRESS=https://meet.example.com`, `CORS_ORIGINS=https://meet.example.com`,
and `BIND_ADDRESS=0.0.0.0` yourself. Caddy provisions HTTPS for the domain. Do not
expose the site over plain HTTP on a public IP; use localhost or a real domain.
This protects meeting data and enables browser microphone capture.

After adding API keys to root `.env`, set `DEMO_MODE=false` and run:

```bash
docker compose up -d --force-recreate backend
docker compose logs --tail 100 backend
```

## Verify and maintain

```powershell
# With the configured Python virtual environment activated:
python -m unittest discover -s backend -p 'test_*.py'
npm run build:web
```

GitHub Actions runs the same meeting lifecycle tests against PostgreSQL, builds
the frontend, starts all Docker services, and checks gateway authentication.

```bash
docker compose ps
docker compose logs --tail 100
docker compose restart
docker compose down
```

`docker compose down` keeps database volumes. Do not use `down -v` unless you
intend to delete all meeting data. Back up PostgreSQL regularly:

```bash
docker compose exec -T database pg_dump -U meetintel meetintel > meetintel-backup.sql
# Restore into a stopped/empty app workspace:
docker compose exec -T database psql -U meetintel meetintel < meetintel-backup.sql
```

Local SQLite data lives in `backend/meetintel.db`; stop the backend before
copying it for backup. The database schema is created at startup. The current
snapshot schema is version 1; future schema changes require migration scripts.

## Deployment status

No remote server or domain was supplied, and Docker is not installed on the
setup machine. The repository contains the deployment stack, but an internet
deployment requires a Docker host. API keys can be added later; no real meeting
audio is sent to AI providers in demo mode.
