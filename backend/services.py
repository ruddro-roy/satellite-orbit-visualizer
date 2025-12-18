from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Dict, List, Optional
import asyncio
import requests
from skyfield.api import EarthSatellite, load, wgs84

TLE_SOURCE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle"
CACHE_TTL_MINUTES = 60

class SatelliteServiceError(Exception):
    pass

class SatelliteService:
    def __init__(self):
        self._tle_cache: Dict[str, object] = {
            "fetched_at": None,
            "satellites": [],
            "lookup": {},
        }
        self._cache_lock = Lock()
        self.ts = load.timescale()

    def get_tle_catalog(self, force_refresh: bool = False) -> List[Dict[str, str]]:
        now = datetime.now(timezone.utc)
        with self._cache_lock:
            fetched_at = self._tle_cache.get("fetched_at")
            cache_is_stale = not fetched_at or (now - fetched_at) > timedelta(
                minutes=CACHE_TTL_MINUTES
            )
            if not force_refresh and not cache_is_stale:
                return self._tle_cache["satellites"]

            try:
                response = requests.get(TLE_SOURCE_URL, timeout=30)
                response.raise_for_status()
            except requests.RequestException as err:
                raise SatelliteServiceError(f"Failed to fetch TLE data: {err}") from err

            catalog = self._parse_tle_catalog(response.text)
            if not catalog:
                 raise SatelliteServiceError("Received empty TLE catalog")

            lookup = {entry["satellite_number"]: entry for entry in catalog}
            self._tle_cache.update(
                {
                    "fetched_at": now,
                    "satellites": catalog,
                    "lookup": lookup,
                }
            )
            return catalog

    def get_satellite_by_id(self, satellite_id: str) -> Optional[Dict[str, str]]:
        with self._cache_lock:
             return self._tle_cache["lookup"].get(satellite_id)

    def _parse_tle_catalog(self, raw_text: str) -> List[Dict[str, str]]:
        lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
        catalog: List[Dict[str, str]] = []
        i = 0
        while i < len(lines):
            if (
                lines[i].startswith("1 ")
                and i + 1 < len(lines)
                and lines[i + 1].startswith("2 ")
            ):
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

    def compute_passes(
        self,
        tle_entry: Dict[str, str],
        lat: float,
        lon: float,
        altitude_m: float,
        max_results: int,
        days: float = 1.5, # 36 hours
        min_altitude_deg: float = 0.0
    ) -> List[Dict[str, object]]:

        satellite = EarthSatellite(
            tle_entry["line1"], tle_entry["line2"], tle_entry["name"], self.ts
        )
        observer = wgs84.latlon(lat, lon, elevation_m=altitude_m)

        t0 = self.ts.now()
        t1 = self.ts.from_datetime(t0.utc_datetime() + timedelta(days=days))

        t, events = satellite.find_events(observer, t0, t1, altitude_degrees=min_altitude_deg)

        passes = []
        current_pass = {}

        # Events: 0=rise, 1=culminate, 2=set
        for ti, event in zip(t, events):
            # We need to calculate az/alt for this time
            difference = satellite - observer
            topocentric = difference.at(ti)
            alt, az, _ = topocentric.altaz()

            iso_time = ti.utc_iso().replace("+00:00", "Z")

            if event == 0: # Rise
                current_pass = {
                    "rise_time": iso_time,
                    "rise_azimuth_deg": round(az.degrees, 2)
                }
            elif event == 1: # Culminate
                # If we missed the rise (e.g. started in middle of pass), we might not have current_pass initialized
                if "rise_time" not in current_pass:
                    # Satellite was already visible.
                    # Use start time t0 for rise time, but we need azimuth at t0
                    # For simplicity, we can set rise_time to None or try to estimate.
                    # But the requirement is "currently visible", so using t0 is reasonable.
                    # We need to compute azimuth at t0.

                    # Compute Az/Alt at t0
                    diff_t0 = satellite - observer
                    topo_t0 = diff_t0.at(t0)
                    _, az_t0, _ = topo_t0.altaz()

                    current_pass["rise_time"] = t0.utc_iso().replace("+00:00", "Z")
                    current_pass["rise_azimuth_deg"] = round(az_t0.degrees, 2)

                current_pass["max_altitude_deg"] = round(alt.degrees, 2)
                current_pass["max_altitude_time"] = iso_time
            elif event == 2: # Set
                current_pass["set_time"] = iso_time
                current_pass["set_azimuth_deg"] = round(az.degrees, 2)

                # If we missed rise and culminate (e.g. started just before set)
                if "rise_time" not in current_pass:
                     diff_t0 = satellite - observer
                     topo_t0 = diff_t0.at(t0)
                     _, az_t0, _ = topo_t0.altaz()
                     current_pass["rise_time"] = t0.utc_iso().replace("+00:00", "Z")
                     current_pass["rise_azimuth_deg"] = round(az_t0.degrees, 2)

                # If we missed culminate (e.g. started after culminate but before set)
                if "max_altitude_deg" not in current_pass:
                     # This happens if we only see the descent.
                     # The max altitude in *our window* was at t0.
                     diff_t0 = satellite - observer
                     topo_t0 = diff_t0.at(t0)
                     alt_t0, _, _ = topo_t0.altaz()
                     current_pass["max_altitude_deg"] = round(alt_t0.degrees, 2)
                     current_pass["max_altitude_time"] = t0.utc_iso().replace("+00:00", "Z")

                if "rise_time" in current_pass and "max_altitude_deg" in current_pass:
                     passes.append(current_pass)

                current_pass = {}

                if len(passes) >= max_results:
                    break

        return passes

# Singleton instance
service = SatelliteService()
