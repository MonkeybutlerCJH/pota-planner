# **POTA Planner — Implementation Plan**

Each step produces a working, testable increment. Test the listed check before moving on.

---

## **Step 1: Project skeleton \+ database \+ health check**

Create the directory structure, `requirements.txt`, `database.py` with all three tables (parks, activations, media), and `main.py` with FastAPI serving a single `GET /api/health` endpoint that returns `{"status": "ok"}`. Auto-create `data/`, `data/photos/`, `data/docs/` on startup. Include `run.sh`.

**Files:** `main.py`, `database.py`, `requirements.txt`, `run.sh`

**Test:** Run `run.sh`, hit `http://localhost:8000/api/health`, confirm 200\. Confirm `data/` dirs exist. Confirm `pota_planner.db` was created with all three tables (use `sqlite3` CLI).

---

## **Step 2: POTA API proxy endpoints**

Add the two proxy endpoints: `GET /api/pota/park/{reference}` and `GET /api/pota/parks/location/{location}`. Use `httpx` with a 10-second timeout. Cache responses in a simple in-memory dict with TTL (e.g. 5 minutes). Return a friendly JSON error if upstream is unreachable.

**Files:** `main.py` (add routes), `requirements.txt` (add httpx)

**Test:** `curl localhost:8000/api/pota/park/K-1234` returns park JSON. `curl localhost:8000/api/pota/parks/location/US-PA` returns a list. Kill network and confirm a graceful error response.

---

## **Step 3: Parks CRUD endpoints**

Add `GET /api/parks` (with optional `?activated=true`, `?wishlist=true` filters), `GET /api/parks/{reference}` (includes related media and activations), `POST /api/parks/{reference}/notes` (upsert notes, creates stub if park doesn't exist), and `POST /api/parks/{reference}/wishlist` (toggle).

**Files:** `database.py` (add helper functions), `main.py` (add routes)

**Test:** POST notes to a new park reference — confirm the row is created. GET it back. Toggle wishlist on/off. GET `/api/parks?wishlist=true` and confirm filtering works. Confirm `last_updated` is set on every write.

---

## **Step 4: CSV import endpoint**

Add `POST /api/import/activations`. Accept multipart file upload. Parse the `activator_parks.csv` format — extract `park_reference` and `count` columns. For each row, upsert into parks table setting `activated=1` and `activation_count`. Skip malformed rows with a logged warning. Return `{"imported": N, "skipped": M}`.

**Files:** `main.py` (add route), `database.py` (add upsert helper)

**Test:** Create a small test CSV with 3 good rows and 1 bad row. POST it via curl with `-F "file=@test.csv"`. Confirm 3 parks created with correct activation counts, 1 skipped. Confirm existing notes are preserved on re-import.

---

## **Step 5: Media upload, delete, cover endpoints**

Add `POST /api/parks/{reference}/media` (multipart upload — resize photos with Pillow to max 1920px longest side, save as JPEG 85%; save PDFs as-is). Add `DELETE /api/media/{id}` (removes DB row \+ file). Add `POST /api/media/{id}/cover` (sets cover, unsets previous). Mount `data/photos` at `/photos` and `data/docs` at `/docs` as static file paths.

**Files:** `main.py` (add routes \+ static mounts), `database.py` (media helpers), `requirements.txt` (add Pillow)

**Test:** Upload a large JPEG — confirm it's resized and saved under `data/photos/{ref}/`. Upload a PDF — confirm saved under `data/docs/{ref}/`. Set cover, confirm only one cover per park. Delete — confirm file removed from disk and DB.

---

## **Step 6: Activation log endpoint**

Add `POST /api/parks/{reference}/activations` to create an activation record (date, bands\_modes, qso\_count, cell\_service\_actual, would\_return, post\_notes). Activations should already be returned nested in `GET /api/parks/{reference}` from Step 3 — confirm they are, sorted newest first.

**Files:** `main.py`, `database.py`

**Test:** POST an activation, GET the park detail, confirm it appears. Post two more, confirm ordering is newest-first.

---

## **Step 7: Frontend shell — HTML, CSS, top bar, map**

Create `static/index.html`, `static/style.css`, `static/app.js`. Set up the dark-themed layout: top bar with app title, Import CSV button, and search input. Full-height Leaflet map using OpenStreetMap tiles. Include Leaflet and Leaflet.markercluster from CDN. Mount `static/` in FastAPI. No side panel yet — just the map centered on the US.

**Files:** `static/index.html`, `static/style.css`, `static/app.js`, update `main.py` (mount static)

**Test:** Open `localhost:8000` in browser. See dark-themed page with map filling the screen. Pan and zoom work. Top bar visible with placeholder buttons.

---

## **Step 8: Map markers from local DB**

On page load, fetch `GET /api/parks` and place markers on the map. Color them: green=activated, yellow=wishlist, grey=other. Use markercluster. Clicking a marker logs the park reference to the console (side panel comes later).

**Files:** `static/app.js`

**Test:** Import a CSV (Step 4\) so you have parks in the DB. Reload the page — see green markers. Toggle one to wishlist via curl, reload — see yellow marker. Confirm clustering at low zoom.

---

## **Step 9: Dynamic POTA API markers on pan/zoom**

When the user stops panning/zooming (debounced \~500ms), calculate the visible bounds and fetch parks from the POTA API proxy for visible area. Show API-only parks as blue markers. Don't duplicate parks already in local DB. Merge into the marker cluster layer.

**Files:** `static/app.js`

**Test:** Pan to a region you haven't imported. See blue markers appear after a short delay. Pan back to an area with imported parks — no duplicates, colors correct.

---

## **Step 10: Side panel — structure and park header**

Add the slide-in side panel (400px from right). When a marker is clicked, fetch `GET /api/parks/{reference}` (or create a stub from POTA API data if it doesn't exist locally). Display: park name, reference, link to pota.app, activated/unactivated badge, activation count, wishlist star toggle. Map resizes when panel opens/closes.

**Files:** `static/app.js`, `static/style.css`, `static/index.html`

**Test:** Click a marker — panel slides in, header info is correct. Click the star — wishlist toggles (confirm via API). Click a blue (API-only) marker — stub is created, panel shows. Close panel — map reclaims the space.

---

## **Step 11: Side panel — research notes (inline editing)**

Add all note fields to the panel below the header. Each field shows its current value (or placeholder text). Clicking a field turns it into an input/textarea. On blur or Enter, auto-save via `POST /api/parks/{reference}/notes`. Show a brief "Saved" indicator.

**Fields:** parking, bathroom, antenna, noise, cell service, walk distance, special rules, general notes.

**Files:** `static/app.js`, `static/style.css`

**Test:** Click a park, edit parking notes, click away — reload the page, reopen the park, confirm the note persisted. Edit multiple fields rapidly — all save correctly.

---

## **Step 12: Side panel — media section (photos \+ PDFs)**

Add the media section. Show cover photo large if one exists, then a thumbnail strip of all photos. Show PDF list with category badges (clickable to open in new tab). Add upload buttons for photos and PDFs. Clicking a photo opens a simple lightbox overlay. Add context actions: set as cover, delete (via confirm dialog).

**Files:** `static/app.js`, `static/style.css`

**Test:** Upload a photo — see it appear as thumbnail. Set as cover — see it displayed large. Upload a PDF — see it listed. Delete a photo — gone from UI and disk. Open lightbox — shows full image.

---

## **Step 13: Side panel — activation history \+ log modal**

Show activation history list (newest first) with date, bands/modes, QSO count, star rating, notes. Add "Log Activation" button that opens a modal form with: date picker, bands/modes text input, QSO count number input, cell service text input, 1–5 star rating (clickable stars), post-trip notes textarea. On submit, POST to the API, close modal, refresh the list.

**Files:** `static/app.js`, `static/style.css`

**Test:** Log an activation — confirm it appears in the list. Log another — confirm ordering. Confirm all fields round-trip correctly.

---

## **Step 14: Search \+ CSV import modal**

**Search:** Wire up the search bar. On keypress (debounced), query `GET /api/pota/park/{input}` for exact reference match, or search by name. Show results in a dropdown. Clicking a result flies the map to that park and opens the side panel (creating a stub if needed).

**Import CSV:** Wire up the Import button. Show a modal with instructions, link to pota.app profile, and a file picker. On file select, POST to `/api/import/activations`, show the result count, then refresh map markers.

**Files:** `static/app.js`, `static/style.css`

**Test:** Search for "K-1234" — see result, click it, map flies there, panel opens. Import a real `activator_parks.csv` — see count, markers turn green on map.

---

## **Step 15: Polish and edge cases**

* Add a "All data stored locally" note in the footer or top bar.  
* Handle POTA API unreachable gracefully in the UI (toast/banner, continue with local data).  
* Add loading spinners for API calls.  
* Confirm no crash if DB is empty on first load.  
* Confirm photo upload with filename collisions appends UUID.  
* Test the full flow end-to-end: fresh start → import CSV → search a park → add notes → upload photo → log activation → verify everything persists across server restart.

**Files:** All frontend files, minor backend tweaks.

**Test:** Full walkthrough as described above. Kill the POTA API proxy (block outbound) and confirm the app remains usable with local data.

