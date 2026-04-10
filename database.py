import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

DATA_DIR = os.environ.get("DATA_DIR", "data")
DB_PATH = os.path.join(DATA_DIR, "pota_planner.db")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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

            CREATE TABLE IF NOT EXISTS locations (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                park_reference  TEXT NOT NULL REFERENCES parks(reference),
                type            TEXT NOT NULL,
                latitude        REAL NOT NULL,
                longitude       REAL NOT NULL,
                title           TEXT,
                notes           TEXT,
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

        # Migrate parking_locations → locations (type='parking')
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='parking_locations'"
        ).fetchone()
        if exists:
            for col in ("title TEXT", "notes TEXT"):
                try:
                    conn.execute(f"ALTER TABLE parking_locations ADD COLUMN {col}")
                except Exception:
                    pass
            conn.execute("""
                INSERT INTO locations (park_reference, type, latitude, longitude, title, notes, created_at)
                SELECT park_reference, 'parking', latitude, longitude,
                       COALESCE(title, ''), COALESCE(notes, ''), created_at
                FROM parking_locations
            """)
            conn.execute("DROP TABLE parking_locations")

        # Migrate activation_locations → locations (type='activation')
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='activation_locations'"
        ).fetchone()
        if exists:
            conn.execute("""
                INSERT INTO locations (park_reference, type, latitude, longitude, title, notes, created_at)
                SELECT park_reference, 'activation', latitude, longitude,
                       COALESCE(title, ''), COALESCE(notes, ''), created_at
                FROM activation_locations
            """)
            conn.execute("DROP TABLE activation_locations")


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


# ---------------------------------------------------------------------------
# Parks
# ---------------------------------------------------------------------------

NOTE_FIELDS = {
    "parking_notes", "bathroom_notes", "antenna_notes", "noise_notes",
    "cell_service", "walk_distance", "special_rules", "general_notes",
}


def search_parks(query: str, limit: int = 10) -> list:
    """Search local DB parks by reference or name (case-insensitive)."""
    q = f"%{query.upper()}%"
    with get_conn() as conn:
        rows = conn.execute(
            """
            SELECT * FROM parks
            WHERE UPPER(reference) LIKE ?
               OR UPPER(COALESCE(name, '')) LIKE ?
            ORDER BY
              CASE WHEN UPPER(reference) = ? THEN 0
                   WHEN UPPER(reference) LIKE ? THEN 1
                   ELSE 2 END,
              name
            LIMIT ?
            """,
            (q, q, query.upper(), f"{query.upper()}%", limit),
        ).fetchall()
    return rows_to_list(rows)


def get_all_parks(activated: bool | None = None, wishlist: bool | None = None) -> list:
    conditions = []
    params = []
    if activated is not None:
        conditions.append("activated = ?")
        params.append(1 if activated else 0)
    if wishlist is not None:
        conditions.append("wishlist = ?")
        params.append(1 if wishlist else 0)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    with get_conn() as conn:
        rows = conn.execute(f"SELECT * FROM parks {where}", params).fetchall()
    return rows_to_list(rows)


def get_park(reference: str) -> dict | None:
    with get_conn() as conn:
        park = row_to_dict(
            conn.execute("SELECT * FROM parks WHERE reference = ?", (reference,)).fetchone()
        )
        if park is None:
            return None

        park["media"] = rows_to_list(
            conn.execute(
                "SELECT * FROM media WHERE park_reference = ? ORDER BY is_cover DESC, created_at ASC",
                (reference,),
            ).fetchall()
        )
        park["activations"] = rows_to_list(
            conn.execute(
                "SELECT * FROM activations WHERE park_reference = ? ORDER BY activation_date DESC, created_at DESC",
                (reference,),
            ).fetchall()
        )
        park["locations"] = rows_to_list(
            conn.execute(
                "SELECT * FROM locations WHERE park_reference = ? ORDER BY type, id ASC",
                (reference,),
            ).fetchall()
        )
    return park


def upsert_park_stub(reference: str, name: str = None, latitude: float = None,
                     longitude: float = None) -> None:
    """Create a minimal park record if one doesn't exist yet."""
    pota_url = f"https://pota.app/#/park/{reference}"
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO parks (reference, name, latitude, longitude, pota_url, last_updated)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(reference) DO NOTHING
            """,
            (reference, name, latitude, longitude, pota_url, now_iso()),
        )


def upsert_park_notes(reference: str, fields: dict) -> bool:
    """
    Upsert note fields for a park. Creates a stub record if the park doesn't
    exist. Returns True if the park existed, False if a stub was created.
    """
    # Filter to only known note fields
    safe = {k: v for k, v in fields.items() if k in NOTE_FIELDS}

    with get_conn() as conn:
        existing = conn.execute(
            "SELECT reference FROM parks WHERE reference = ?", (reference,)
        ).fetchone()

        if existing is None:
            pota_url = f"https://pota.app/#/park/{reference}"
            conn.execute(
                "INSERT INTO parks (reference, pota_url, last_updated) VALUES (?, ?, ?)",
                (reference, pota_url, now_iso()),
            )

        if safe:
            set_clause = ", ".join(f"{k} = ?" for k in safe)
            params = list(safe.values()) + [now_iso(), reference]
            conn.execute(
                f"UPDATE parks SET {set_clause}, last_updated = ? WHERE reference = ?",
                params,
            )

    return existing is not None


def set_wishlist(reference: str, wishlist: bool) -> bool:
    """Toggle wishlist flag. Returns False if the park doesn't exist."""
    with get_conn() as conn:
        result = conn.execute(
            "UPDATE parks SET wishlist = ?, last_updated = ? WHERE reference = ?",
            (1 if wishlist else 0, now_iso(), reference),
        )
    return result.rowcount > 0


# ---------------------------------------------------------------------------
# CSV import
# ---------------------------------------------------------------------------

def import_activation_csv(rows: list[dict]) -> tuple[int, int]:
    """
    Upsert parks from parsed CSV rows. Handles both the spec column names
    (park_reference/count) and the actual pota.app export column names
    (reference/activations). Preserves existing note fields.
    Returns (imported, skipped).
    """
    imported = 0
    skipped = 0
    ts = now_iso()

    with get_conn() as conn:
        for row in rows:
            # Support both column name conventions
            ref = (row.get("reference") or row.get("park_reference") or "").strip()
            count_raw = (row.get("activations") or row.get("count") or "").strip()

            if not ref or not count_raw:
                skipped += 1
                continue

            try:
                count = int(count_raw)
            except ValueError:
                skipped += 1
                continue

            pota_url = f"https://pota.app/#/park/{ref}"
            name = (row.get("park name") or row.get("name") or "").strip() or None
            conn.execute(
                """
                INSERT INTO parks (reference, name, pota_url, activated, activation_count, last_updated)
                VALUES (?, ?, ?, 1, ?, ?)
                ON CONFLICT(reference) DO UPDATE SET
                    activated = 1,
                    activation_count = excluded.activation_count,
                    name = COALESCE(name, excluded.name),
                    last_updated = excluded.last_updated
                """,
                (ref, name, pota_url, count, ts),
            )
            imported += 1

    return imported, skipped


def update_park_coordinates(parks_from_api: list[dict]) -> int:
    """
    Given a list of park dicts from the POTA API, update lat/lng/name for any
    parks we have in the DB that are missing coordinates. Returns count updated.
    """
    updated = 0
    with get_conn() as conn:
        for p in parks_from_api:
            ref = p.get("reference", "").strip()
            lat = p.get("latitude")
            lng = p.get("longitude")
            name = p.get("name")
            if not ref or lat is None or lng is None:
                continue
            result = conn.execute(
                """
                UPDATE parks SET
                    latitude  = COALESCE(latitude, ?),
                    longitude = COALESCE(longitude, ?),
                    name      = COALESCE(name, ?)
                WHERE reference = ?
                  AND (latitude IS NULL OR longitude IS NULL)
                """,
                (lat, lng, name, ref),
            )
            updated += result.rowcount
    return updated


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------

def insert_media(park_reference: str, file_path: str, file_type: str,
                 category: str, caption: str = "") -> dict:
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO media (park_reference, file_path, file_type, category, caption, is_cover, created_at)
            VALUES (?, ?, ?, ?, ?, 0, ?)
            """,
            (park_reference, file_path, file_type, category, caption, now_iso()),
        )
        row = conn.execute("SELECT * FROM media WHERE id = ?", (cur.lastrowid,)).fetchone()
    return row_to_dict(row)


def delete_media(media_id: int) -> str | None:
    """Delete media record. Returns file_path if found, None if not."""
    with get_conn() as conn:
        row = conn.execute("SELECT file_path FROM media WHERE id = ?", (media_id,)).fetchone()
        if row is None:
            return None
        conn.execute("DELETE FROM media WHERE id = ?", (media_id,))
    return row["file_path"]


# ---------------------------------------------------------------------------
# Activations
# ---------------------------------------------------------------------------

def insert_activation(park_reference: str, activation_date: str, bands_modes: str,
                      qso_count: int, cell_service_actual: str,
                      would_return: int, post_notes: str) -> dict:
    upsert_park_stub(park_reference)
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO activations
                (park_reference, activation_date, bands_modes, qso_count,
                 cell_service_actual, would_return, post_notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (park_reference, activation_date, bands_modes, qso_count,
             cell_service_actual, would_return, post_notes, now_iso()),
        )
        row = conn.execute(
            "SELECT * FROM activations WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return row_to_dict(row)


# ---------------------------------------------------------------------------
# Locations (parking, activation, …)
# ---------------------------------------------------------------------------

def insert_location(park_reference: str, loc_type: str, latitude: float,
                    longitude: float, title: str = "", notes: str = "") -> dict:
    with get_conn() as conn:
        cur = conn.execute(
            """
            INSERT INTO locations (park_reference, type, latitude, longitude, title, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (park_reference, loc_type, latitude, longitude, title, notes, now_iso()),
        )
        row = conn.execute(
            "SELECT * FROM locations WHERE id = ?", (cur.lastrowid,)
        ).fetchone()
    return row_to_dict(row)


def update_location(loc_id: int, title: str, latitude: float,
                    longitude: float, notes: str) -> dict | None:
    with get_conn() as conn:
        result = conn.execute(
            """
            UPDATE locations
            SET title = ?, latitude = ?, longitude = ?, notes = ?
            WHERE id = ?
            """,
            (title, latitude, longitude, notes, loc_id),
        )
        if result.rowcount == 0:
            return None
        row = conn.execute(
            "SELECT * FROM locations WHERE id = ?", (loc_id,)
        ).fetchone()
    return row_to_dict(row)


def delete_location(loc_id: int) -> bool:
    with get_conn() as conn:
        result = conn.execute("DELETE FROM locations WHERE id = ?", (loc_id,))
    return result.rowcount > 0


def set_cover(media_id: int) -> bool:
    """Set a photo as cover for its park, unsetting any previous cover."""
    with get_conn() as conn:
        row = conn.execute(
            "SELECT park_reference FROM media WHERE id = ? AND file_type = 'photo'",
            (media_id,),
        ).fetchone()
        if row is None:
            return False
        park_ref = row["park_reference"]
        conn.execute(
            "UPDATE media SET is_cover = 0 WHERE park_reference = ?", (park_ref,)
        )
        conn.execute("UPDATE media SET is_cover = 1 WHERE id = ?", (media_id,))
    return True
