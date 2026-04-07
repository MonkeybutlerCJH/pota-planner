# POTA Planner — Build Progress

## Steps

- [x] **Step 1**: Project skeleton + database + health check
  - `main.py`, `database.py`, `pyproject.toml`, `run.sh`
  - All 4 DB tables created, `data/` dirs auto-created, `GET /api/health` returns 200
  - Committed to git

- [x] **Step 2**: POTA API proxy endpoints
  - `GET /api/pota/park/{reference}` and `GET /api/pota/parks/location/{location}`
  - httpx with 10s timeout, in-memory cache (~5min TTL), graceful error if upstream unreachable

- [ ] **Step 3**: Parks CRUD endpoints
  - `GET /api/parks` (with `?activated=true`, `?wishlist=true` filters)
  - `GET /api/parks/{reference}` (nested media + activations, newest first)
  - `POST /api/parks/{reference}/notes` (upsert, creates stub if missing)
  - `POST /api/parks/{reference}/wishlist` (toggle)

- [ ] **Step 4**: CSV import endpoint
  - `POST /api/import/activations` — parse `activator_parks.csv`, upsert `activated=1` + `activation_count`
  - Skip malformed rows, return `{"imported": N, "skipped": M}`, never overwrite notes

- [ ] **Step 5**: Media upload/delete/cover endpoints
  - `POST /api/parks/{reference}/media` — resize photos (max 1920px, JPEG 85%), PDFs as-is
  - `DELETE /api/media/{id}`, `POST /api/media/{id}/cover`
  - Mount `data/photos` → `/photos`, `data/docs` → `/docs`

- [ ] **Step 6**: Activation log endpoint
  - `POST /api/parks/{reference}/activations`
  - Verify activations nested in `GET /api/parks/{reference}`, sorted newest first

- [ ] **Step 7**: Frontend shell — HTML, CSS, map
  - `static/index.html`, `static/style.css`, `static/app.js`
  - Dark theme, top bar (Import CSV, Search), full-height Leaflet map + markercluster (CDN)
  - Mount `static/` in FastAPI

- [ ] **Step 8**: Map markers from local DB
  - Fetch `/api/parks` on load, render colored markers
  - Green=activated, Yellow=wishlist, Grey=other; markercluster at low zoom

- [ ] **Step 9**: Dynamic POTA API markers on pan/zoom
  - Debounced (~500ms) handler fetches POTA API parks for visible bounds
  - Blue markers for parks not in local DB, no duplicates

- [ ] **Step 10**: Side panel — structure and park header
  - Slide-in right panel (~400px), map resizes on open/close
  - Park name, reference, pota.app link, activated badge, wishlist star, activation count

- [ ] **Step 11**: Side panel — research notes inline editing
  - 8 fields: parking, bathroom, antenna, noise, cell service, walk distance, special rules, general notes
  - Click to edit, blur/Enter auto-saves, brief "Saved" indicator

- [ ] **Step 12**: Side panel — media section
  - Cover photo, thumbnail strip, PDF list with category badges
  - Upload buttons, lightbox, right-click/long-press → set cover / delete

- [ ] **Step 13**: Side panel — activation history + log modal
  - List of past activations, newest first
  - "Log Activation" modal: date, bands/modes, QSO count, cell service, 1–5 star rating, notes

- [ ] **Step 14**: Search + CSV import modal
  - Search bar: debounced, dropdown results, fly-to + open panel on click
  - Import CSV modal: instructions, pota.app link, file picker, refresh markers after import

- [ ] **Step 15**: Polish and edge cases
  - "All data stored locally" note in UI
  - Graceful POTA API failure (toast/banner, continue with local data)
  - Loading spinners, empty DB handling, filename collision UUIDs
  - Full end-to-end walkthrough test
