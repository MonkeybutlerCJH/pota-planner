import os
import sqlite3
from contextlib import contextmanager

DATA_DIR = os.environ.get("DATA_DIR", "data")
DB_PATH = os.path.join(DATA_DIR, "pota_planner.db")


def init_db():
    """Create data directories and initialize the database schema."""
    os.makedirs(os.path.join(DATA_DIR, "photos"), exist_ok=True)
    os.makedirs(os.path.join(DATA_DIR, "docs"), exist_ok=True)

    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS parks (
                reference           TEXT PRIMARY KEY,
                name                TEXT,
                latitude            REAL,
                longitude           REAL,
                pota_url            TEXT,
                activated           INTEGER DEFAULT 0,
                activation_count    INTEGER DEFAULT 0,
                wishlist            INTEGER DEFAULT 0,
                parking_notes       TEXT,
                bathroom_notes      TEXT,
                antenna_notes       TEXT,
                noise_notes         TEXT,
                cell_service        TEXT,
                walk_distance       TEXT,
                special_rules       TEXT,
                general_notes       TEXT,
                last_updated        TEXT
            );

            CREATE TABLE IF NOT EXISTS parking_locations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                park_reference  TEXT NOT NULL REFERENCES parks(reference),
                latitude        REAL NOT NULL,
                longitude       REAL NOT NULL,
                description     TEXT,
                created_at      TEXT
            );

            CREATE TABLE IF NOT EXISTS activations (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                park_reference      TEXT NOT NULL REFERENCES parks(reference),
                activation_date     TEXT,
                bands_modes         TEXT,
                qso_count           INTEGER,
                cell_service_actual TEXT,
                would_return        INTEGER,
                post_notes          TEXT,
                created_at          TEXT
            );

            CREATE TABLE IF NOT EXISTS media (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                park_reference  TEXT NOT NULL REFERENCES parks(reference),
                file_path       TEXT,
                file_type       TEXT,
                category        TEXT,
                caption         TEXT,
                is_cover        INTEGER DEFAULT 0,
                created_at      TEXT
            );
        """)


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]
