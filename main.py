import csv
import io
import logging
import os
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
    DATA_DIR, init_db,
    get_all_parks, get_park, upsert_park_notes, upsert_park_stub, set_wishlist,
    import_activation_csv, insert_media, delete_media, set_cover,
    insert_activation,
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
    if entry and (time.monotonic() - entry[0]) < CACHE_TTL:
        return entry[1]
    return None


def _cache_set(key: str, data):
    _cache[key] = (time.monotonic(), data)


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

@app.get("/api/parks")
def list_parks(activated: Optional[bool] = None, wishlist: Optional[bool] = None):
    return get_all_parks(activated=activated, wishlist=wishlist)


@app.get("/api/parks/{reference}")
def get_park_detail(reference: str):
    park = get_park(reference)
    if park is None:
        raise HTTPException(status_code=404, detail="Park not found")
    return park


class NotesBody(BaseModel):
    parking_notes: Optional[str] = None
    bathroom_notes: Optional[str] = None
    antenna_notes: Optional[str] = None
    noise_notes: Optional[str] = None
    cell_service: Optional[str] = None
    walk_distance: Optional[str] = None
    special_rules: Optional[str] = None
    general_notes: Optional[str] = None


@app.post("/api/parks/{reference}/notes")
def update_notes(reference: str, body: NotesBody):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    upsert_park_notes(reference, fields)
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
    return {"imported": imported, "skipped": skipped}

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
