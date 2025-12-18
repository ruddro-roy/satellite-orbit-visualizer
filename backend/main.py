"""FastAPI backend powering the satellite orbit visualizer.

This service fetches Two-Line Element (TLE) data from CelesTrak, caches
it, and exposes endpoints for the frontend to retrieve catalog
information and request precise pass predictions computed with Skyfield.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Dict, List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from services import service

app = FastAPI(
    title="Satellite Orbit Visualizer API",
    version="0.1.0",
    description=(
        "Backend service that provides satellite TLE catalogs and predictive "
        "visibility windows for observers on Earth."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class PassPredictionRequest(BaseModel):
    """Input payload for requesting pass predictions."""

    satellite_id: str = Field(..., description="NORAD catalog identifier (e.g., 25544)")
    observer_lat: float = Field(..., ge=-90.0, le=90.0)
    observer_lon: float = Field(..., ge=-180.0, le=180.0)
    observer_alt_m: float = Field(0.0, ge=-430.0, le=10000.0)
    max_results: int = Field(5, ge=1, le=10)


def _isoformat(dt: datetime) -> str:
    """Return an ISO-8601 string with a trailing Z for UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


@app.on_event("startup")
async def prime_tle_cache() -> None:
    """Fetch TLE data on startup so the first request is fast."""
    try:
        await asyncio.to_thread(service.get_tle_catalog)
    except Exception:
        # On cold start we can continue even if the fetch fails; the next
        # request will retry.
        pass


@app.get("/tles")
async def list_tles(force_refresh: bool = False) -> Dict[str, object]:
    """Return the cached TLE catalog."""
    try:
        catalog = await asyncio.to_thread(service.get_tle_catalog, force_refresh)
        fetched_at = service._tle_cache.get("fetched_at")
        return {
            "fetched_at": _isoformat(fetched_at) if fetched_at else None,
            "count": len(catalog),
            "satellites": catalog,
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/predict")
async def predict_passes(payload: PassPredictionRequest) -> Dict[str, object]:
    """Compute the next visible passes for a satellite and observer."""

    # Ensure we have catalog
    try:
        await asyncio.to_thread(service.get_tle_catalog)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    tle_entry = service.get_satellite_by_id(payload.satellite_id)
    if not tle_entry:
        raise HTTPException(status_code=404, detail="Satellite not found in catalog")

    passes = await asyncio.to_thread(
        service.compute_passes,
        tle_entry,
        payload.observer_lat,
        payload.observer_lon,
        payload.observer_alt_m,
        payload.max_results,
    )

    return {
        "satellite_id": payload.satellite_id,
        "name": tle_entry["name"],
        "requested_at": _isoformat(datetime.now(timezone.utc)),
        "passes": passes,
    }
