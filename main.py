import os
import time
from contextlib import asynccontextmanager
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import (
    DATA_DIR, init_db,
    get_all_parks, get_park, upsert_park_notes, upsert_park_stub, set_wishlist,
)

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
# Static file mounts
# ---------------------------------------------------------------------------

app.mount("/photos", StaticFiles(directory=os.path.join(DATA_DIR, "photos")), name="photos")
app.mount("/docs", StaticFiles(directory=os.path.join(DATA_DIR, "docs")), name="docs")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
