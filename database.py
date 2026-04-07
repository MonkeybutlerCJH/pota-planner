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


# ---------------------------------------------------------------------------
# Parks
# ---------------------------------------------------------------------------

NOTE_FIELDS = {
    "parking_notes", "bathroom_notes", "antenna_notes", "noise_notes",
    "cell_service", "walk_distance", "special_rules", "general_notes",
}


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
        park["parking_locations"] = rows_to_list(
            conn.execute(
                "SELECT * FROM parking_locations WHERE park_reference = ? ORDER BY id ASC",
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
    Upsert parks from parsed CSV rows. Each row must have 'park_reference' and
    'count'. Preserves existing note fields. Returns (imported, skipped).
    """
    imported = 0
    skipped = 0
    ts = now_iso()

    with get_conn() as conn:
        for row in rows:
            ref = row.get("park_reference", "").strip()
            count_raw = row.get("count", "").strip()

            if not ref or not count_raw:
                skipped += 1
                continue

            try:
                count = int(count_raw)
            except ValueError:
                skipped += 1
                continue

            pota_url = f"https://pota.app/#/park/{ref}"
            conn.execute(
                """
                INSERT INTO parks (reference, pota_url, activated, activation_count, last_updated)
                VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(reference) DO UPDATE SET
                    activated = 1,
                    activation_count = excluded.activation_count,
                    last_updated = excluded.last_updated
                """,
                (ref, pota_url, count, ts),
            )
            imported += 1

    return imported, skipped
