# **POTA Planner — Build Specification**

## **Project Overview**

Build a local web application called **POTA Planner** for planning and researching Parks on the Air (POTA) amateur radio activations. It runs entirely on the user's machine — no cloud, no accounts, no sync. The user starts it from the terminal and accesses it in their browser.

---

## **Tech Stack**

* **Backend**: Python with FastAPI  
* **Database**: SQLite (via SQLModel or plain sqlite3)  
* **Frontend**: Plain HTML, CSS, vanilla JavaScript — no frameworks  
* **Map**: Leaflet.js with OpenStreetMap tiles  
* **Image processing**: Pillow (for resize/compress on upload)  
* **Server**: Uvicorn

All dependencies must be installable via `pip`. Provide a `requirements.txt`.

Provide a `run.sh` script that installs deps (if needed) and starts the server. The app should open at `http://localhost:8000`.

---

## **Project Structure**

pota-planner/  
├── main.py                  \# FastAPI app entry point  
├── database.py              \# DB init, models, helpers  
├── requirements.txt  
├── run.sh  
├── static/  
│   ├── index.html           \# Main SPA shell  
│   ├── app.js               \# All frontend logic  
│   └── style.css  
└── data/                    \# Created at runtime  
    ├── pota\_planner.db  
    ├── photos/  
    │   └── {park\_reference}/  
    └── docs/  
        └── {park\_reference}/

The `data/` directory should be created automatically on first run if it doesn't exist.

---

## **Data Model**

### **Table: `parks`**

Stores per-park research notes. Park reference is the primary key (e.g. `K-1234`).

| Column | Type | Notes |
| ----- | ----- | ----- |
| reference | TEXT PK | e.g. `K-1234` |
| name | TEXT | From POTA API |
| latitude | REAL | From POTA API |
| longitude | REAL | From POTA API |
| pota\_url | TEXT | `https://pota.app/#/park/{reference}` |
| activated | INTEGER | 0 or 1, set by CSV import |
| activation\_count | INTEGER | How many times activated, from CSV |
| wishlist | INTEGER | 0 or 1, user toggled |
| parking\_notes | TEXT | User entered |
| bathroom\_notes | TEXT | User entered |
| antenna\_notes | TEXT | User entered (space, directions, restrictions) |
| noise\_notes | TEXT | User entered (power lines, industrial, etc.) |
| cell\_service | TEXT | User entered (e.g. "Verizon good, AT\&T none") |
| walk\_distance | TEXT | User entered (e.g. "200m from lot to clearing") |
| special\_rules | TEXT | User entered (permits, seasonal closures) |
| general\_notes | TEXT | Freeform user notes |
| last\_updated | TEXT | ISO timestamp, updated on any write |

### **Table: `activations`**

One row per activation the user has done at a park.

| Column | Type | Notes |
| ----- | ----- | ----- |
| id | INTEGER PK AUTOINCREMENT |  |
| park\_reference | TEXT FK | References parks.reference |
| activation\_date | TEXT | ISO date |
| bands\_modes | TEXT | e.g. "40m SSB, 20m FT8" |
| qso\_count | INTEGER |  |
| cell\_service\_actual | TEXT | What they actually experienced |
| would\_return | INTEGER | 1-5 rating |
| post\_notes | TEXT | Freeform post-activation notes |
| created\_at | TEXT | ISO timestamp |

### **Table: `media`**

Tracks photos and PDFs attached to a park.

| Column | Type | Notes |
| ----- | ----- | ----- |
| id | INTEGER PK AUTOINCREMENT |  |
| park\_reference | TEXT FK |  |
| file\_path | TEXT | Relative path under data/ |
| file\_type | TEXT | `photo` or `pdf` |
| category | TEXT | For photos: `scouting`, `setup`, `view`, `other`. For PDFs: `park_map`, `trail_map`, `permit`, `other` |
| caption | TEXT | User entered |
| is\_cover | INTEGER | 0 or 1, only one photo per park should be cover |
| created\_at | TEXT | ISO timestamp |

---

## **API Endpoints**

### **Parks**

| Method | Path | Description |
| ----- | ----- | ----- |
| GET | `/api/parks` | List all parks in local DB. Optional query params: `?activated=true`, `?wishlist=true` |
| GET | `/api/parks/{reference}` | Get one park's full record including media |
| POST | `/api/parks/{reference}/notes` | Upsert the research notes fields for a park. Body is JSON with any subset of note fields. Creates park record if it doesn't exist. |
| POST | `/api/parks/{reference}/wishlist` | Toggle wishlist. Body: `{"wishlist": true}` |

### **POTA API Proxy**

The frontend should not call the POTA API directly to avoid CORS issues. Proxy through the backend.

| Method | Path | Description |
| ----- | ----- | ----- |
| GET | `/api/pota/park/{reference}` | Proxy to `https://api.pota.app/park/{reference}` |
| GET | `/api/pota/parks/location/{location}` | Proxy to `https://api.pota.app/location/parks/{location}` — returns all parks for a location code (e.g. `US-PA`) |

### **CSV Import**

| Method | Path | Description |
| ----- | ----- | ----- |
| POST | `/api/import/activations` | Accept multipart file upload of `activator_parks.csv` from pota.app. Parse it, upsert parks table setting `activated=1` and `activation_count` for each park in the CSV. Return count of parks imported. |

The CSV from pota.app has columns including `park_reference` and `count` (number of activations). Parse accordingly, but be defensive — log and skip malformed rows rather than erroring.

### **Media**

| Method | Path | Description |
| ----- | ----- | ----- |
| POST | `/api/parks/{reference}/media` | Multipart upload. Accept photo (jpg/png/webp/gif) or PDF. For photos: use Pillow to resize to max 1920px on longest side, save as JPEG at 85% quality. Save to `data/photos/{reference}/`. For PDFs: save as-is to `data/docs/{reference}/`. Insert media record. |
| DELETE | `/api/media/{id}` | Delete media record and file from disk |
| POST | `/api/media/{id}/cover` | Set this photo as cover for its park (unset any existing cover) |

### **Static file serving**

Mount `data/photos` at `/photos` and `data/docs` at `/docs` so the browser can load media directly.

---

## **Frontend — Single Page App**

The app is a single HTML page with a full-height map and a slide-in side panel.

### **Layout**

\+--------------------------------------------------+  
|  POTA Planner          \[Import CSV\] \[🔍 Search\]  |  \<- top bar  
\+--------------------------------------------------+  
|                    |                             |  
|                    |    SIDE PANEL               |  
|     MAP            |    (slides in on click)     |  
|    (Leaflet)       |                             |  
|                    |                             |  
\+--------------------------------------------------+

Map takes full remaining height. Side panel slides in from the right at \~400px wide when a park is selected. Map resizes to accommodate it (don't overlay).

### **Map Behavior**

* Default center: USA, zoom level appropriate to see the country  
* Load park markers from local DB on startup (`GET /api/parks`)  
* Also fetch parks for the visible area from POTA API when the user pans/zooms (debounced, don't hammer the API)  
* **Marker colors**:  
  * Green: activated (in local DB with activated=1)  
  * Yellow: on wishlist  
  * Grey: unactivated, in local DB  
  * Blue: from POTA API, not yet in local DB  
* Cluster markers at low zoom levels (use Leaflet.markercluster)  
* Clicking a marker opens the side panel for that park

### **Side Panel — Park Detail**

When a park is clicked, show:

**Header section**

* Park name and reference  
* Link to pota.app page (opens in new tab)  
* Activated badge (green) or Unactivated badge (grey)  
* Wishlist toggle button (star icon)  
* Activation count if activated

**Media section**

* Cover photo displayed prominently if one exists  
* Thumbnail strip of all photos  
* List of PDFs with name and category badge, click to open in new tab  
* Upload button for photos (accepts jpg/png/webp)  
* Upload button for PDFs  
* Click a photo to view full size in a lightbox  
* Right-click or long-press photo for options: Set as cover, Delete

**Research Notes section** All fields are inline-editable. Click a field to edit, blur or Enter to save (auto-save via PATCH/POST, no save button needed).

Fields:

* Parking Notes  
* Bathroom Notes  
* Antenna Notes (space, directions, restrictions)  
* Noise Floor Notes  
* Cell Service (by carrier)  
* Walk Distance  
* Special Rules (permits, seasonal closures)  
* General Notes (large textarea)

**Activation History section** List of past activations from `activations` table for this park, newest first. Each shows date, bands/modes, QSO count, rating, notes.

"Log Activation" button opens a modal form to add a new activation record with fields: date, bands/modes used, QSO count, cell service experienced, would-return rating (1-5 stars), post-trip notes.

### **Import CSV Flow**

Top bar "Import CSV" button:

1. Opens a small modal explaining: "Export your activator stats CSV from pota.app → My Stats → Export CSV"  
2. Provides a direct link to `https://pota.app/#/profile`  
3. File picker for the CSV  
4. On upload, POST to `/api/import/activations`, show result count  
5. Refresh map markers after import

### **Search**

Search bar in top bar. Searches park name or reference. Hits the POTA API proxy, shows results in a dropdown, clicking one flies the map to that park and opens its side panel. If the park is not in local DB yet, create a stub record from the POTA API data before opening the panel.

---

## **POTA API Notes**

Base URL: `https://api.pota.app`

Useful endpoints:

* `GET /park/{reference}` — single park detail, returns `{reference, name, latitude, longitude, locationName, ...}`  
* `GET /location/parks/{location}` — all parks in a location like `US-PA`  
* `GET /parks/grids/{grid}` — parks in a Maidenhead grid square

No authentication required for any of these. Be a good citizen — add a reasonable timeout and don't hammer it. Cache responses in memory for the session where sensible.

The POTA API may have CORS restrictions when called directly from the browser. Always proxy through the FastAPI backend.

---

## **Behavior Details & Edge Cases**

* If a park clicked on the map doesn't exist in local DB yet, auto-fetch from POTA API proxy and create a stub record before showing the panel  
* The `data/` directory and all subdirectories must be created on startup if they don't exist  
* Photo upload: if the park subdirectory doesn't exist, create it  
* Filename collisions on upload: append a timestamp or UUID to avoid overwriting  
* CSV import is additive — it updates `activated` and `activation_count` but does not delete existing note data  
* All timestamps stored as ISO 8601 UTC strings  
* The app should not crash if the POTA API is unreachable — show a friendly inline error and continue with local data only

---

## **Style & UX Notes**

* Dark theme preferred — ham radio operators often run apps at night or in dark vehicles  
* Clean, utilitarian aesthetic — this is a field research tool, not a consumer app  
* Mobile-responsive is not a requirement — desktop browser only is fine  
* No authentication, no login, no user accounts  
* All data is local — make this clear in the UI ("All data stored locally")

---

## **Startup**

Running `python main.py` or `uvicorn main:app --reload` should:

1. Create `data/` directories if needed  
2. Initialize SQLite DB and run migrations if needed  
3. Start the server on port 8000  
4. Print a startup message with the URL

Optionally, `run.sh` can open the browser automatically (`xdg-open http://localhost:8000` on Linux).

---

## **Out of Scope**

* User authentication  
* Cloud sync  
* Mobile support  
* Offline map tiles  
* Real-time POTA spots / live activator tracking  
* ADIF import/export  
* Multi-user support

---

## **Cory’s add-on thoughts**

* There could be multiple parking locations and are always going to be lat/long (and maybe text describing each one). These locations should also be pinned on the map.  
* All locations need to have a link to open up in Google Maps to that location.  
* Keep the `data/` path configurable via an environment variable — makes Docker volume mounting trivial  
* Use a `pyproject.toml` instead of just `requirements.txt` — works with uv, pip, and packaging tools  
* Don't hardcode `localhost` anywhere in the frontend — use relative paths so it works behind any host  
  