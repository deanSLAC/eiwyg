"""Database layer for EIWYG. Uses PostgreSQL when PG env vars are set, SQLite otherwise.

Set EIWYG_ENV=production to require PostgreSQL and prevent silent fallback
to ephemeral SQLite inside a container.
"""
import json
import os
import sys
from datetime import datetime, timezone

# ── Backend detection ────────────────────────────────────────────────────

_EIWYG_ENV = os.environ.get("EIWYG_ENV", "dev").lower()
_PGHOST = os.environ.get("PGHOST")
_PGPORT = os.environ.get("PGPORT", "5432")
_PGUSER = os.environ.get("PGUSER")
_PGPASSWORD = os.environ.get("PGPASSWORD")
_PGDATABASE = os.environ.get("PGDATABASE", "eiwyg")
_DATABASE_URL = os.environ.get("DATABASE_URL")

USE_POSTGRES = bool(_DATABASE_URL or _PGHOST)

if _EIWYG_ENV == "production" and not USE_POSTGRES:
    print(
        "FATAL: EIWYG_ENV=production but no PostgreSQL credentials found. "
        "Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD env vars.",
        file=sys.stderr,
    )
    sys.exit(1)

_DB_PATH = os.path.join(os.path.dirname(__file__), "..", "eiwyg.db")

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS dashboards (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    config TEXT NOT NULL DEFAULT '{"widgets":[],"columns":12}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

# Module-level pool for postgres
_pool = None


# ── Postgres helpers ─────────────────────────────────────────────────────

def _get_dsn() -> str:
    if _DATABASE_URL:
        return _DATABASE_URL
    return f"postgresql://{_PGUSER}:{_PGPASSWORD}@{_PGHOST}:{_PGPORT}/{_PGDATABASE}"


# ── Public API ───────────────────────────────────────────────────────────

async def init_db():
    global _pool
    if USE_POSTGRES:
        import asyncpg
        dsn = _get_dsn()
        _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5)
        async with _pool.acquire() as conn:
            await conn.execute(_CREATE_TABLE)
        print(f"Database: PostgreSQL ({_PGHOST or 'DATABASE_URL'})")
    else:
        import aiosqlite
        async with aiosqlite.connect(_DB_PATH) as db:
            await db.execute(_CREATE_TABLE)
            await db.commit()
        print(f"Database: SQLite ({_DB_PATH})")


async def close_db():
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def save_dashboard(slug: str, title: str, description: str,
                         username: str, config: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    config_json = json.dumps(config)

    if USE_POSTGRES:
        async with _pool.acquire() as conn:
            await conn.execute(
                """INSERT INTO dashboards (slug, title, description, username, config, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)
                   ON CONFLICT (slug) DO UPDATE
                   SET title=$2, description=$3, username=$4, config=$5, updated_at=$7""",
                slug, title, description, username, config_json, now, now)
    else:
        import aiosqlite
        async with aiosqlite.connect(_DB_PATH) as db:
            existing = await db.execute(
                "SELECT slug FROM dashboards WHERE slug = ?", (slug,))
            row = await existing.fetchone()
            if row:
                await db.execute(
                    """UPDATE dashboards
                       SET title=?, description=?, username=?, config=?, updated_at=?
                       WHERE slug=?""",
                    (title, description, username, config_json, now, slug))
            else:
                await db.execute(
                    """INSERT INTO dashboards (slug, title, description, username, config, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (slug, title, description, username, config_json, now, now))
            await db.commit()

    return await get_dashboard(slug)


async def get_dashboard(slug: str) -> dict | None:
    if USE_POSTGRES:
        async with _pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM dashboards WHERE slug = $1", slug)
            if not row:
                return None
            d = dict(row)
            d["config"] = json.loads(d["config"])
            return d
    else:
        import aiosqlite
        async with aiosqlite.connect(_DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT * FROM dashboards WHERE slug = ?", (slug,))
            row = await cursor.fetchone()
            if not row:
                return None
            d = dict(row)
            d["config"] = json.loads(d["config"])
            return d


async def list_dashboards(username: str = None) -> list[dict]:
    cols = "slug, title, description, username, created_at, updated_at"

    if USE_POSTGRES:
        async with _pool.acquire() as conn:
            if username:
                rows = await conn.fetch(
                    f"SELECT {cols} FROM dashboards WHERE username = $1 ORDER BY updated_at DESC",
                    username)
            else:
                rows = await conn.fetch(
                    f"SELECT {cols} FROM dashboards ORDER BY updated_at DESC")
            return [dict(r) for r in rows]
    else:
        import aiosqlite
        async with aiosqlite.connect(_DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            if username:
                cursor = await db.execute(
                    f"SELECT {cols} FROM dashboards WHERE username = ? ORDER BY updated_at DESC",
                    (username,))
            else:
                cursor = await db.execute(
                    f"SELECT {cols} FROM dashboards ORDER BY updated_at DESC")
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]


async def get_all_dashboards_with_config() -> list[dict]:
    """Get all dashboards including config - used for LLM search."""
    if USE_POSTGRES:
        async with _pool.acquire() as conn:
            rows = await conn.fetch("SELECT * FROM dashboards ORDER BY updated_at DESC")
            result = []
            for r in rows:
                d = dict(r)
                d["config"] = json.loads(d["config"])
                result.append(d)
            return result
    else:
        import aiosqlite
        async with aiosqlite.connect(_DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute("SELECT * FROM dashboards ORDER BY updated_at DESC")
            rows = await cursor.fetchall()
            result = []
            for r in rows:
                d = dict(r)
                d["config"] = json.loads(d["config"])
                result.append(d)
            return result
