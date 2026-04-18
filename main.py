import csv
import io
import logging
import os
import signal
import time
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from database import (
    DATA_DIR, init_db, get_conn,
    search_parks, get_all_parks, get_park, upsert_park_notes, upsert_park_stub, set_wishlist,
    import_activation_csv, update_park_coordinates,
    insert_media, delete_media, set_cover,
    insert_activation,
    insert_location, update_location, delete_location,
    add_location_photo, delete_location_photo,
    insert_link, delete_link,
    get_all_tags, set_park_tags,
)

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory cache: { cache_key: (timestamp, data) }
# ---------------------------------------------------------------------------
_cache: dict = {}
CACHE_TTL = 300  # seconds

POTA_BASE = "https://api.pota.app"
POTA_TIMEOUT = 10.0


def _cache_get(key: str):
    entry = _cache.get(key)
    if entry is None:
        return None
    ts, data, ttl = entry
    if ttl is not None and (time.monotonic() - ts) >= ttl:
        return None
    return data


def _cache_set(key: str, data, ttl: float | None = CACHE_TTL):
    _cache[key] = (time.monotonic(), data, ttl)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

# Ensure data directories exist before StaticFiles mounts are registered
init_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"\n  POTA Planner running at http://localhost:8000")
    print(f"  Data directory: {os.path.abspath(DATA_DIR)}\n")
    yield


app = FastAPI(title="POTA Planner", lifespan=lifespan)

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/shutdown")
def shutdown():
    os.killpg(os.getpgid(os.getpid()), signal.SIGTERM)
    return {"status": "shutting down"}

# ---------------------------------------------------------------------------
# POTA API proxy
# ---------------------------------------------------------------------------

@app.get("/api/pota/park/{reference}")
async def proxy_park(reference: str):
    key = f"park:{reference}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        async with httpx.AsyncClient(timeout=POTA_TIMEOUT) as client:
            r = await client.get(f"{POTA_BASE}/park/{reference}")
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as e:
        return JSONResponse(
            status_code=e.response.status_code,
            content={"error": f"POTA API returned {e.response.status_code}"},
        )
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"error": "POTA API unreachable", "detail": str(e)},
        )

    _cache_set(key, data)
    return data


@app.get("/api/pota/park-stats/{reference}")
async def proxy_park_stats(reference: str):
    """Return community-wide activations/qsos/attempts for a single park."""
    key = f"stats:{reference}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    with get_conn() as conn:
        row = conn.execute(
            "SELECT location_desc FROM parks WHERE reference = ?", (reference,)
        ).fetchone()

    location_desc = row["location_desc"] if row else None
    if not location_desc:
        return {"activations": None, "qsos": None, "attempts": None}

    # Reuse the cached location payload if already fetched
    loc_key = f"location:{location_desc}"
    parks = _cache_get(loc_key)
    if parks is None:
        try:
            async with httpx.AsyncClient(timeout=POTA_TIMEOUT) as client:
                r = await client.get(f"{POTA_BASE}/location/parks/{location_desc}")
                r.raise_for_status()
                parks = r.json()
        except Exception as e:
            return JSONResponse(
                status_code=503,
                content={"error": "POTA API unreachable", "detail": str(e)},
            )
        _cache_set(loc_key, parks, ttl=None)

    for p in (parks or []):
        if p.get("reference", "").upper() == reference.upper():
            result = {
                "activations": p.get("activations"),
                "qsos": p.get("qsos"),
                "attempts": p.get("attempts"),
            }
            _cache_set(key, result, ttl=None)
            return result

    return {"activations": None, "qsos": None, "attempts": None}


@app.get("/api/pota/locations")
async def proxy_locations():
    key = "all_locations"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        async with httpx.AsyncClient(timeout=POTA_TIMEOUT) as client:
            r = await client.get(f"{POTA_BASE}/locations")
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        return JSONResponse(status_code=503, content={"error": "POTA API unreachable", "detail": str(e)})

    _cache_set(key, data)
    return data


@app.get("/api/pota/parks/location/{location}")
async def proxy_parks_by_location(location: str):
    key = f"location:{location}"
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        async with httpx.AsyncClient(timeout=POTA_TIMEOUT) as client:
            r = await client.get(f"{POTA_BASE}/location/parks/{location}")
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as e:
        return JSONResponse(
            status_code=e.response.status_code,
            content={"error": f"POTA API returned {e.response.status_code}"},
        )
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"error": "POTA API unreachable", "detail": str(e)},
        )

    _cache_set(key, data)
    return data

# ---------------------------------------------------------------------------
# Parks CRUD
# ---------------------------------------------------------------------------

@app.get("/api/search")
async def search(q: str = ""):
    q = q.strip()
    if not q:
        return []

    # Search local DB first
    local = search_parks(q, limit=8)
    found_refs = {p["reference"] for p in local}

    # If query looks like a reference and wasn't in local DB, try POTA API
    results = list(local)
    if "-" in q.upper() and q.upper() not in found_refs:
        try:
            async with httpx.AsyncClient(timeout=POTA_TIMEOUT) as client:
                r = await client.get(f"{POTA_BASE}/park/{q.upper()}")
                if r.status_code == 200:
                    data = r.json()
                    if data and isinstance(data, dict) and data.get("reference"):
                        results.append({
                            "reference": data["reference"],
                            "name": data.get("name"),
                            "latitude": data.get("latitude"),
                            "longitude": data.get("longitude"),
                            "pota_url": f"https://pota.app/#/park/{data['reference']}",
                            "activated": 0,
                            "wishlist": 0,
                            "_source": "pota_api",
                        })
        except Exception:
            pass

    return results


@app.get("/api/tags")
def list_tags():
    return {"tags": get_all_tags()}


@app.get("/api/parks")
def list_parks(activated: Optional[bool] = None, wishlist: Optional[bool] = None,
               tag: Optional[str] = None):
    return get_all_parks(activated=activated, wishlist=wishlist, tag=tag)


@app.get("/api/parks/{reference}")
def get_park_detail(reference: str):
    park = get_park(reference)
    if park is None:
        raise HTTPException(status_code=404, detail="Park not found")
    return park


class NotesBody(BaseModel):
    # Basic park info (used when creating a stub from API data)
    name: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    # Research note fields
    parking_notes: Optional[str] = None
    bathroom_notes: Optional[str] = None
    antenna_notes: Optional[str] = None
    noise_notes: Optional[str] = None
    cell_service: Optional[str] = None
    walk_distance: Optional[str] = None
    special_rules: Optional[str] = None
    general_notes: Optional[str] = None
    location_desc: Optional[str] = None


@app.post("/api/parks/{reference}/notes")
def update_notes(reference: str, body: NotesBody):
    note_fields = {k: v for k, v in body.model_dump().items()
                   if v is not None and k not in ('name', 'latitude', 'longitude', 'location_desc')}
    upsert_park_notes(reference, note_fields)
    # Update name/coordinates/location_desc if provided (fills in stub from POTA API data)
    if any([body.name, body.latitude, body.longitude, body.location_desc]):
        with get_conn() as conn:
            conn.execute(
                """UPDATE parks SET
                    name          = COALESCE(name, ?),
                    latitude      = COALESCE(latitude, ?),
                    longitude     = COALESCE(longitude, ?),
                    location_desc = COALESCE(location_desc, ?)
                   WHERE reference = ?""",
                (body.name, body.latitude, body.longitude, body.location_desc, reference),
            )
    park = get_park(reference)
    return park


class WishlistBody(BaseModel):
    wishlist: bool


@app.post("/api/parks/{reference}/wishlist")
def toggle_wishlist(reference: str, body: WishlistBody):
    # Create stub if park doesn't exist yet
    upsert_park_stub(reference)
    set_wishlist(reference, body.wishlist)
    return {"reference": reference, "wishlist": body.wishlist}


class TagsBody(BaseModel):
    tags: list[str]


@app.post("/api/parks/{reference}/tags")
def update_tags(reference: str, body: TagsBody):
    upsert_park_stub(reference)
    set_park_tags(reference, body.tags)
    return {"reference": reference, "tags": sorted(set(t.strip().lower() for t in body.tags if t.strip()))}


# ---------------------------------------------------------------------------
# Locations (parking, activation, …)
# ---------------------------------------------------------------------------

VALID_LOCATION_TYPES = {"parking", "activation"}


class LocationBody(BaseModel):
    latitude: float
    longitude: float
    title: Optional[str] = ""
    notes: Optional[str] = ""
    type: Optional[str] = None  # required on POST, ignored on PUT


@app.post("/api/parks/{reference}/locations")
def add_location(reference: str, body: LocationBody):
    if body.type not in VALID_LOCATION_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid location type: {body.type!r}")
    upsert_park_stub(reference)
    return insert_location(reference, body.type, body.latitude, body.longitude,
                           title=body.title or "", notes=body.notes or "")


@app.put("/api/locations/{loc_id}")
def edit_location(loc_id: int, body: LocationBody):
    record = update_location(loc_id, body.title or "", body.latitude, body.longitude,
                             body.notes or "")
    if record is None:
        raise HTTPException(status_code=404, detail="Location not found")
    return record


@app.delete("/api/locations/{loc_id}")
def remove_location(loc_id: int):
    photo_paths = delete_location(loc_id)
    if photo_paths is None:
        raise HTTPException(status_code=404, detail="Location not found")
    for path in photo_paths:
        full_path = os.path.join(DATA_DIR, path)
        if os.path.exists(full_path):
            os.remove(full_path)
    return {"deleted": loc_id}


@app.post("/api/locations/{loc_id}/photo")
async def upload_location_photo(loc_id: int, file: UploadFile = File(...)):
    with get_conn() as conn:
        loc_row = conn.execute("SELECT * FROM locations WHERE id = ?", (loc_id,)).fetchone()
    if loc_row is None:
        raise HTTPException(status_code=404, detail="Location not found")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in PHOTO_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext!r}")

    reference = loc_row["park_reference"]
    park_dir = os.path.join(DATA_DIR, "photos", reference)
    os.makedirs(park_dir, exist_ok=True)

    filename = f"loc_{loc_id}_{uuid.uuid4().hex[:8]}.jpg"
    save_path = os.path.join(park_dir, filename)
    rel_path = os.path.join("photos", reference, filename)

    content = await file.read()
    img = Image.open(io.BytesIO(content))
    if img.mode in ("P", "RGBA", "LA"):
        img = img.convert("RGB")
    w, h = img.size
    if max(w, h) > MAX_PHOTO_PX:
        scale = MAX_PHOTO_PX / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    img.save(save_path, "JPEG", quality=PHOTO_QUALITY, optimize=True)

    return add_location_photo(loc_id, rel_path)


@app.delete("/api/location-photos/{photo_id}")
def remove_location_photo(photo_id: int):
    file_path = delete_location_photo(photo_id)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Photo not found")
    full_path = os.path.join(DATA_DIR, file_path)
    if os.path.exists(full_path):
        os.remove(full_path)
    return {"deleted": photo_id}


class RotateRequest(BaseModel):
    degrees: int = 90  # 90 = CW, 270 = CCW


@app.post("/api/location-photos/{photo_id}/rotate")
def rotate_location_photo(photo_id: int, body: RotateRequest):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT file_path FROM location_photos WHERE id = ?", (photo_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Photo not found")

    if body.degrees not in (90, 180, 270):
        raise HTTPException(status_code=400, detail="degrees must be 90, 180, or 270")

    abs_path = os.path.join(DATA_DIR, row["file_path"])
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="Photo file not found on disk")

    img = Image.open(abs_path)
    img = img.rotate(-body.degrees, expand=True)
    img.save(abs_path, "JPEG", quality=PHOTO_QUALITY, optimize=True)
    return {"rotated": photo_id, "degrees": body.degrees}


# ---------------------------------------------------------------------------
# Links
# ---------------------------------------------------------------------------

class LinkBody(BaseModel):
    title: str
    url: str


@app.post("/api/parks/{reference}/links")
def add_link(reference: str, body: LinkBody):
    title = body.title.strip()
    url = body.url.strip()
    if not title or not url:
        raise HTTPException(status_code=400, detail="title and url are required")
    upsert_park_stub(reference)
    return insert_link(reference, title, url)


@app.delete("/api/links/{link_id}")
def remove_link(link_id: int):
    if not delete_link(link_id):
        raise HTTPException(status_code=404, detail="Link not found")
    return {"deleted": link_id}


# ---------------------------------------------------------------------------
# CSV import
# ---------------------------------------------------------------------------

@app.post("/api/import/activations")
async def import_activations(file: UploadFile = File(...)):
    content = await file.read()
    try:
        text = content.decode("utf-8-sig")  # strip BOM if present
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text))

    # Normalise header names: lowercase + strip whitespace
    rows = []
    for raw in reader:
        rows.append({k.lower().strip(): v for k, v in raw.items()})

    if not rows:
        return {"imported": 0, "skipped": 0, "error": "No rows found in CSV"}

    imported, skipped = import_activation_csv(rows)

    # Fetch coordinates from POTA API for each unique location in the CSV
    # (the CSV has a "hasc" column like "US-PA" we can use)
    locations = {r.get("hasc", "").strip() for r in rows if r.get("hasc", "").strip()}
    coords_updated = 0
    async with httpx.AsyncClient(timeout=POTA_TIMEOUT) as client:
        for loc in locations:
            try:
                r = await client.get(f"{POTA_BASE}/location/parks/{loc}")
                if r.status_code == 200:
                    parks_data = r.json()
                    if isinstance(parks_data, list):
                        coords_updated += update_park_coordinates(parks_data)
                        _cache_set(f"location:{loc}", parks_data)
            except Exception:
                pass  # coordinates are best-effort; don't fail the import

    return {"imported": imported, "skipped": skipped, "coords_updated": coords_updated}

# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
PDF_EXTENSION = ".pdf"
MAX_PHOTO_PX = 1920
PHOTO_QUALITY = 85


def _unique_filename(original: str) -> str:
    """Append a short UUID to avoid collisions while keeping the extension."""
    base, ext = os.path.splitext(original)
    return f"{base}_{uuid.uuid4().hex[:8]}{ext}"


# ---------------------------------------------------------------------------
# Activations
# ---------------------------------------------------------------------------

class ActivationBody(BaseModel):
    activation_date: str
    bands_modes: Optional[str] = ""
    qso_count: Optional[int] = 0
    cell_service_actual: Optional[str] = ""
    would_return: Optional[int] = None
    post_notes: Optional[str] = ""


@app.post("/api/parks/{reference}/activations")
def log_activation(reference: str, body: ActivationBody):
    record = insert_activation(
        park_reference=reference,
        activation_date=body.activation_date,
        bands_modes=body.bands_modes or "",
        qso_count=body.qso_count or 0,
        cell_service_actual=body.cell_service_actual or "",
        would_return=body.would_return,
        post_notes=body.post_notes or "",
    )
    return record

# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

@app.post("/api/parks/{reference}/media")
async def upload_media(
    reference: str,
    file: UploadFile = File(...),
    category: str = Form("other"),
    caption: str = Form(""),
):
    # Ensure the park exists
    upsert_park_stub(reference)

    ext = os.path.splitext(file.filename or "")[1].lower()

    if ext in PHOTO_EXTENSIONS:
        file_type = "photo"
        park_dir = os.path.join(DATA_DIR, "photos", reference)
        os.makedirs(park_dir, exist_ok=True)

        filename = _unique_filename(os.path.basename(file.filename or "photo.jpg"))
        save_path = os.path.join(park_dir, filename)
        rel_path = os.path.join("photos", reference, filename)

        content = await file.read()
        img = Image.open(io.BytesIO(content))

        # Convert palette/RGBA modes so JPEG save works
        if img.mode in ("P", "RGBA", "LA"):
            img = img.convert("RGB")

        # Resize if needed
        w, h = img.size
        if max(w, h) > MAX_PHOTO_PX:
            scale = MAX_PHOTO_PX / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        img.save(save_path, "JPEG", quality=PHOTO_QUALITY, optimize=True)

    elif ext == PDF_EXTENSION:
        file_type = "pdf"
        park_dir = os.path.join(DATA_DIR, "docs", reference)
        os.makedirs(park_dir, exist_ok=True)

        filename = _unique_filename(os.path.basename(file.filename or "document.pdf"))
        save_path = os.path.join(park_dir, filename)
        rel_path = os.path.join("docs", reference, filename)

        content = await file.read()
        with open(save_path, "wb") as f:
            f.write(content)

    else:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {ext}")

    record = insert_media(reference, rel_path, file_type, category, caption)
    return record


@app.delete("/api/media/{media_id}")
def remove_media(media_id: int):
    file_path = delete_media(media_id)
    if file_path is None:
        raise HTTPException(status_code=404, detail="Media not found")

    full_path = os.path.join(DATA_DIR, file_path)
    if os.path.exists(full_path):
        os.remove(full_path)

    return {"deleted": media_id}


@app.post("/api/media/{media_id}/cover")
def set_cover_photo(media_id: int):
    if not set_cover(media_id):
        raise HTTPException(status_code=404, detail="Photo not found")
    return {"cover": media_id}


@app.post("/api/media/{media_id}/rotate")
def rotate_photo(media_id: int, body: RotateRequest):
    with get_conn() as conn:
        row = conn.execute(
            "SELECT file_path FROM media WHERE id = ? AND file_type = 'photo'",
            (media_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Photo not found")

    if body.degrees not in (90, 180, 270):
        raise HTTPException(status_code=400, detail="degrees must be 90, 180, or 270")

    abs_path = os.path.join(DATA_DIR, row["file_path"])
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="Photo file not found on disk")

    img = Image.open(abs_path)
    # Pillow rotate is CCW; negate to rotate CW
    img = img.rotate(-body.degrees, expand=True)
    img.save(abs_path, "JPEG", quality=PHOTO_QUALITY, optimize=True)
    return {"rotated": media_id, "degrees": body.degrees}

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Static file mounts
# ---------------------------------------------------------------------------

@app.get("/")
def serve_index():
    return FileResponse("static/index.html")

app.mount("/photos", StaticFiles(directory=os.path.join(DATA_DIR, "photos")), name="photos")
app.mount("/docs", StaticFiles(directory=os.path.join(DATA_DIR, "docs")), name="docs")
app.mount("/static", StaticFiles(directory="static"), name="static")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
