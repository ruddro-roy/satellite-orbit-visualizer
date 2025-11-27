"""FastAPI backend powering the satellite orbit visualizer.

This service fetches Two-Line Element (TLE) data from CelesTrak, caches
it, and exposes endpoints for the frontend to retrieve catalog
information and request precise pass predictions computed with Skyfield.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Dict, List

import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from skyfield.api import EarthSatellite, load, wgs84

TLE_SOURCE_URL = (
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"
)
CACHE_TTL_MINUTES = 60  # refresh every 1 hour
PREDICTION_WINDOW_HOURS = 36
TIME_STEP_MINUTES = 1

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

# Skyfield time scale used across the module.
ts = load.timescale()

_tle_cache: Dict[str, object] = {
    "fetched_at": None,
    "satellites": [],
    "lookup": {},
}
_cache_lock = Lock()


class PassPredictionRequest(BaseModel):
    """Input payload for requesting pass predictions."""

    satellite_id: str = Field(..., description="NORAD catalog identifier (e.g., 25544)")
    observer_lat: float = Field(..., ge=-90.0, le=90.0)
    observer_lon: float = Field(..., ge=-180.0, le=180.0)
    observer_alt_m: float = Field(0.0, ge=-430.0, le=10000.0)
    max_results: int = Field(5, ge=1, le=10)


async def get_tle_catalog(force_refresh: bool = False) -> List[Dict[str, str]]:
    """Return cached TLE data, refreshing from CelesTrak if stale."""

    return await asyncio.to_thread(_ensure_tle_cache, force_refresh)


def _ensure_tle_cache(force_refresh: bool = False) -> List[Dict[str, str]]:
    now = datetime.now(timezone.utc)
    with _cache_lock:
        fetched_at = _tle_cache.get("fetched_at")
        cache_is_stale = not fetched_at or (now - fetched_at) > timedelta(
            minutes=CACHE_TTL_MINUTES
        )
        if not force_refresh and not cache_is_stale:
            return _tle_cache["satellites"]  # type: ignore[return-value]

        try:
            response = requests.get(TLE_SOURCE_URL, timeout=30)
            response.raise_for_status()
        except requests.RequestException as err:
            raise HTTPException(status_code=502, detail=f\"Failed to fetch TLE data: {err}\") from err

        catalog = _parse_tle_catalog(response.text)
        if not catalog:
            raise HTTPException(status_code=502, detail="Received empty TLE catalog")

        lookup = {entry["satellite_number"]: entry for entry in catalog}
        _tle_cache.update(
            {
                "fetched_at": now,
                "satellites": catalog,
                "lookup": lookup,
            }
        )
        return catalog


def _parse_tle_catalog(raw_text: str) -> List[Dict[str, str]]:
    """Convert raw TLE text into structured dictionaries."""

    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    catalog: List[Dict[str, str]] = []
    i = 0
    while i < len(lines):
        if (
            lines[i].startswith("1 ")
            and i + 1 < len(lines)
            and lines[i + 1].startswith("2 ")
        ):
            # No name line provided, synthesize one from the catalog number.
            line1 = lines[i]
            line2 = lines[i + 1]
            name_line = f"SAT-{line1[2:7].strip()}"
            i += 2
        elif (
            i + 2 < len(lines)
            and lines[i + 1].startswith("1 ")
            and lines[i + 2].startswith("2 ")
        ):
            name_line = lines[i]
            line1 = lines[i + 1]
            line2 = lines[i + 2]
            i += 3
        else:
            i += 1
            continue

        satnum = line1[2:7].strip()
        catalog.append(
            {
                "name": name_line,
                "line1": line1,
                "line2": line2,
                "satellite_number": satnum,
            }
        )

    return catalog


def _isoformat(dt: datetime) -> str:
    """Return an ISO-8601 string with a trailing Z for UTC."""

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _compute_passes(
    tle_entry: Dict[str, str],
    lat: float,
    lon: float,
    altitude_m: float,
    max_results: int,
) -> List[Dict[str, object]]:
    satellite = EarthSatellite(
        tle_entry["line1"], tle_entry["line2"], tle_entry["name"], ts
    )
    observer = wgs84.latlon(lat, lon, elevation_m=altitude_m)
    start_dt = datetime.now(timezone.utc)

    total_minutes = int(PREDICTION_WINDOW_HOURS * 60)
    datetimes = [
        start_dt + timedelta(minutes=offset)
        for offset in range(0, total_minutes + 1, TIME_STEP_MINUTES)
    ]
    ts_batch = ts.from_datetimes(datetimes)

    difference = satellite - observer
    topocentric = difference.at(ts_batch)
    altitudes, azimuths, _ = topocentric.altaz()

    alt_series = altitudes.degrees
    az_series = azimuths.degrees

    passes: List[Dict[str, object]] = []
    in_pass = False
    start_idx = 0
    max_idx = 0
    max_altitude = -90.0

    for idx, alt_value in enumerate(alt_series):
        alt_value = float(alt_value)
        if not in_pass and alt_value > 0.0:
            in_pass = True
            start_idx = idx
            max_idx = idx
            max_altitude = alt_value
            continue

        if in_pass:
            if alt_value > max_altitude:
                max_altitude = alt_value
                max_idx = idx

            is_last_point = idx == len(alt_series) - 1
            crosses_horizon = alt_value <= 0.0

            if crosses_horizon or is_last_point:
                end_idx = idx if not crosses_horizon else max(idx - 1, start_idx)
                passes.append(
                    {
                        "rise_time": _isoformat(datetimes[start_idx]),
                        "set_time": _isoformat(datetimes[end_idx]),
                        "max_altitude_deg": round(max_altitude, 2),
                        "max_altitude_time": _isoformat(datetimes[max_idx]),
                        "rise_azimuth_deg": round(float(az_series[start_idx]), 2),
                        "set_azimuth_deg": round(float(az_series[end_idx]), 2),
                    }
                )
                in_pass = False

        if len(passes) >= max_results:
            break

    return passes


@app.on_event("startup")
async def prime_tle_cache() -> None:
    """Fetch TLE data on startup so the first request is fast."""

    try:
        await get_tle_catalog()
    except HTTPException:
        # On cold start we can continue even if the fetch fails; the next
        # request will retry.
        pass


@app.get("/tles")
async def list_tles(force_refresh: bool = False) -> Dict[str, object]:
    """Return the cached TLE catalog."""

    catalog = await get_tle_catalog(force_refresh)
    fetched_at = _tle_cache.get("fetched_at")
    return {
        "fetched_at": _isoformat(fetched_at) if fetched_at else None,
        "count": len(catalog),
        "satellites": catalog,
    }


@app.post("/predict")
async def predict_passes(payload: PassPredictionRequest) -> Dict[str, object]:
    """Compute the next visible passes for a satellite and observer."""

    await get_tle_catalog()
    tle_entry = _tle_cache["lookup"].get(payload.satellite_id)
    if not tle_entry:
        raise HTTPException(status_code=404, detail="Satellite not found in catalog")

    passes = await asyncio.to_thread(
        _compute_passes,
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
