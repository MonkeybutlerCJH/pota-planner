# POTA Planner

A local web application for planning and researching [Parks on the Air (POTA)](https://pota.app) amateur radio activations. Runs entirely on your machine — no cloud, no accounts, no sync. All data is stored locally in a SQLite database.

## Features

- **Interactive map** — Leaflet map with OpenStreetMap tiles showing all your activated parks (green), wishlist parks (yellow), and unactivated local parks (grey). Blue markers show additional parks pulled live from the POTA API as you pan and zoom.
- **Import your activations** — Upload your activator stats CSV from pota.app to populate your activated parks on the map.
- **Park research notes** — Click any park to open a side panel with inline-editable fields for parking, antennas, noise floor, cell service, walk distance, special rules, and general notes. All fields auto-save.
- **Media** — Attach scouting photos, setup photos, park maps, and trail maps to any park. Photos are automatically resized to 1920px. Set a cover photo, view in a lightbox.
- **Activation log** — Log each activation with date, bands/modes, QSO count, cell service observed, a 1–5 star would-return rating, and post-trip notes.
- **Parking locations** — Store multiple parking spots with coordinates and Google Maps links.
- **Search** — Search parks by name or reference number from the top bar.

## Prerequisites

- Python 3.10 or newer
- `pip` (included with Python)

That's it. No Node.js, no Docker, no external database. SQLite is part of Python's standard library and requires no separate installation.

## Installation

```bash
git clone <repo-url>
cd "POTA Planner"
```

## Running

```bash
./run.sh
```

This will:
1. Create a Python virtual environment (`.venv/`) on first run
2. Install dependencies from `pyproject.toml`
3. Start the server at [http://localhost:8000](http://localhost:8000)
4. Open the browser automatically (Linux only, requires `xdg-open`)

Or start manually:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
python main.py
```

## Getting Started

1. Open [http://localhost:8000](http://localhost:8000) in your browser
2. Click **Import CSV** in the top bar
3. Export your activator stats from [pota.app → My Stats](https://pota.app/#/profile) and select the downloaded CSV file
4. Your activated parks will appear as green markers on the map
5. Click any marker to open the park detail panel

## Data Storage

All data lives in the `data/` directory created automatically on first run:

```
data/
├── pota_planner.db      # SQLite database
├── photos/              # Uploaded photos (auto-resized to max 1920px)
└── docs/                # Uploaded PDFs
```

To back up your data, copy the `data/` directory. To move the app to another machine, copy both the project folder and `data/`.

The `data/` path can be overridden with the `DATA_DIR` environment variable (useful for Docker volume mounting):

```bash
DATA_DIR=/mnt/external/pota-data ./run.sh
```

## API

The app exposes a REST API at `http://localhost:8000`. Interactive documentation is available at [http://localhost:8000/docs](http://localhost:8000/docs) (FastAPI's built-in Swagger UI).

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python, FastAPI, Uvicorn |
| Database | SQLite |
| Frontend | HTML, CSS, vanilla JavaScript |
| Map | Leaflet.js + OpenStreetMap |
| Image processing | Pillow |
| POTA data | [api.pota.app](https://api.pota.app) (proxied, no auth required) |
