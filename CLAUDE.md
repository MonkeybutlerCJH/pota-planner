# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

POTA Planner is a local web app for planning Parks on the Air (POTA) amateur radio activations. It runs entirely on the user's machine — no cloud, no accounts, no sync. Started from terminal, accessed at `http://localhost:8000`.

## Tech Stack

- **Backend**: Python + FastAPI, served by Uvicorn
- **Database**: SQLite via plain `sqlite3` (or SQLModel)
- **Frontend**: Plain HTML + CSS + vanilla JS — no frameworks
- **Map**: Leaflet.js + Leaflet.markercluster (CDN), OpenStreetMap tiles
- **Image processing**: Pillow
- **HTTP client**: `httpx` (for proxying POTA API requests)
- **Package management**: `pyproject.toml` (compatible with `uv`, `pip`, etc.)

## Running the App

```bash
./run.sh          # Installs deps if needed, starts server
python main.py    # Or run directly
uvicorn main:app --reload  # Or with hot-reload during development
```

The app opens at `http://localhost:8000`. On Linux, `run.sh` may auto-open the browser with `xdg-open`.

The `DATA_DIR` environment variable overrides the default `data/` path (useful for Docker volume mounting).

## Project Structure

```
pota-planner/
├── main.py          # FastAPI app — all routes
├── database.py      # DB init, table schemas, helper functions
├── pyproject.toml
├── run.sh
├── static/
│   ├── index.html   # SPA shell
│   ├── app.js       # All frontend logic
│   └── style.css
└── data/            # Auto-created on startup
    ├── pota_planner.db
    ├── photos/{park_reference}/
    └── docs/{park_reference}/
```

## Database Schema

Three tables in `data/pota_planner.db`:

- **`parks`**: One row per park. `reference` (e.g. `K-1234`) is PK. Holds POTA API data (name, lat/lng), user research notes, and flags (`activated`, `wishlist`). Also stores parking locations as lat/lng with descriptions (multiple per park).
- **`activations`**: One row per user activation. FK to `parks.reference`. Holds date, bands/modes, QSO count, cell service observed, 1–5 rating, notes.
- **`media`**: Tracks photos and PDFs per park. FK to `parks.reference`. `file_type` is `photo` or `pdf`. `category` for photos: `scouting/setup/view/other`; for PDFs: `park_map/trail_map/permit/other`. One photo per park can be `is_cover=1`.

All timestamps stored as ISO 8601 UTC strings.

## API Structure

### Backend proxies POTA API (CORS workaround)
- `GET /api/pota/park/{reference}` → proxies `https://api.pota.app/park/{reference}`
- `GET /api/pota/parks/location/{location}` → proxies `https://api.pota.app/location/parks/{location}`

Proxy responses are cached in-memory with ~5 min TTL. Use `httpx` with 10s timeout. Return a friendly JSON error if upstream is unreachable — never crash.

### Parks CRUD
- `GET /api/parks` — list all parks; supports `?activated=true`, `?wishlist=true`
- `GET /api/parks/{reference}` — full park detail including nested media and activations (newest first)
- `POST /api/parks/{reference}/notes` — upsert note fields; creates stub record if park doesn't exist
- `POST /api/parks/{reference}/wishlist` — toggle wishlist; body: `{"wishlist": true}`

### Other endpoints
- `POST /api/import/activations` — multipart CSV upload; sets `activated=1` and `activation_count`; returns `{"imported": N, "skipped": M}`; never overwrites existing notes
- `POST /api/parks/{reference}/media` — photo (resize to max 1920px longest side, JPEG 85%) or PDF upload
- `DELETE /api/media/{id}` — removes DB record and file from disk
- `POST /api/media/{id}/cover` — sets cover photo, unsets any previous cover for that park
- `POST /api/parks/{reference}/activations` — log a new activation

Static mounts: `data/photos` → `/photos`, `data/docs` → `/docs`

## Frontend Architecture

Single-page app (`static/index.html` + `static/app.js` + `static/style.css`).

**Layout**: Top bar (Import CSV, Search) | Full-height Leaflet map | Slide-in right panel (~400px, map resizes to accommodate — no overlay).

**Marker colors**: Green = activated, Yellow = wishlist, Grey = in DB but not activated, Blue = from POTA API only (not in local DB).

**Key frontend behaviors**:
- On load: fetch `/api/parks` and render all local markers
- On pan/zoom (debounced ~500ms): fetch POTA API parks for visible bounds, add blue markers for parks not already in local DB
- Clicking a marker: if park exists locally, show panel; if not (blue marker), auto-fetch from POTA proxy, create stub record, then open panel
- Note fields: inline-editable, auto-save on blur/Enter via `POST /api/parks/{reference}/notes`, show brief "Saved" indicator
- All API calls use relative URLs (no hardcoded `localhost`)

**Side panel sections** (in order):
1. Header: name, reference, pota.app link (new tab), activated badge, wishlist star toggle, activation count
2. Media: cover photo, thumbnail strip, PDF list, upload buttons, lightbox on photo click, right-click/long-press for set-cover/delete
3. Research notes: 8 inline-editable fields
4. Activation history: list + "Log Activation" modal (date, bands/modes, QSO count, cell service, 1–5 star rating, notes)

## Key Design Decisions

- **Parking locations** are stored as lat/lng pairs (multiple per park) and pinned on the map when a park is selected. Each has a Google Maps link.
- **Dark theme** throughout — operators use this at night and in vehicles.
- **No save button** — all note fields auto-save on blur/Enter.
- **CSV import is additive** — updates activated/count flags but never overwrites user notes.
- **Filename collisions** on upload: append timestamp or UUID.
- `data/` directory and all subdirectories created automatically on startup.

## Implementation Plan

See `POTA Planner — Implementation Plan.md` for the 15-step incremental build plan. Each step is independently testable. Steps 1–6 are backend-only; Steps 7–15 build the frontend incrementally.
