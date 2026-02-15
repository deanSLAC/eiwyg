"""SQLite database layer for EIWYG."""
import aiosqlite
import json
import os
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "..", "eiwyg.db")

CREATE_TABLE = """
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


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(CREATE_TABLE)
        await db.commit()


async def save_dashboard(slug: str, title: str, description: str,
                         username: str, config: dict) -> dict:
    now = datetime.now(timezone.utc).isoformat()
    async with aiosqlite.connect(DB_PATH) as db:
        existing = await db.execute(
            "SELECT slug FROM dashboards WHERE slug = ?", (slug,))
        row = await existing.fetchone()
        if row:
            await db.execute(
                """UPDATE dashboards
                   SET title=?, description=?, username=?, config=?, updated_at=?
                   WHERE slug=?""",
                (title, description, username, json.dumps(config), now, slug))
        else:
            await db.execute(
                """INSERT INTO dashboards (slug, title, description, username, config, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (slug, title, description, username, json.dumps(config), now, now))
        await db.commit()
    return await get_dashboard(slug)


async def get_dashboard(slug: str) -> dict | None:
    async with aiosqlite.connect(DB_PATH) as db:
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
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if username:
            cursor = await db.execute(
                "SELECT slug, title, description, username, created_at, updated_at "
                "FROM dashboards WHERE username = ? ORDER BY updated_at DESC",
                (username,))
        else:
            cursor = await db.execute(
                "SELECT slug, title, description, username, created_at, updated_at "
                "FROM dashboards ORDER BY updated_at DESC")
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]


async def get_all_dashboards_with_config() -> list[dict]:
    """Get all dashboards including config - used for LLM search."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM dashboards ORDER BY updated_at DESC")
        rows = await cursor.fetchall()
        result = []
        for r in rows:
            d = dict(r)
            d["config"] = json.loads(d["config"])
            result.append(d)
        return result
