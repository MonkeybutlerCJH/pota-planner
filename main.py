import os
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from database import DATA_DIR, init_db


# Ensure data directories exist before StaticFiles mounts are registered
init_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"\n  POTA Planner running at http://localhost:8000")
    print(f"  Data directory: {os.path.abspath(DATA_DIR)}\n")
    yield


app = FastAPI(title="POTA Planner", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Static file mounts
app.mount("/photos", StaticFiles(directory=os.path.join(DATA_DIR, "photos")), name="photos")
app.mount("/docs", StaticFiles(directory=os.path.join(DATA_DIR, "docs")), name="docs")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
