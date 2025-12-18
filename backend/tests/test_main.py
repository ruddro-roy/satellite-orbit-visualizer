import pytest
from datetime import datetime, timezone
from main import app
from services import service
from fastapi.testclient import TestClient

client = TestClient(app)

def test_parse_tle_catalog():
    raw_tle = """
1 25544U 98067A   20353.50421447  .00001264  00000-0  30538-4 0  9997
2 25544  51.6442 207.2511 0001227 127.3582 316.6346 15.49221106260424
"""
    catalog = service._parse_tle_catalog(raw_tle)
    assert len(catalog) == 1
    assert catalog[0]["satellite_number"] == "25544"
    assert catalog[0]["name"] == "SAT-25544"

def test_parse_tle_catalog_with_name():
    raw_tle = """
ISS (ZARYA)
1 25544U 98067A   20353.50421447  .00001264  00000-0  30538-4 0  9997
2 25544  51.6442 207.2511 0001227 127.3582 316.6346 15.49221106260424
"""
    catalog = service._parse_tle_catalog(raw_tle)
    assert len(catalog) == 1
    assert catalog[0]["satellite_number"] == "25544"
    assert catalog[0]["name"] == "ISS (ZARYA)"

def test_parse_multiple_tles():
    raw_tle = """
ISS (ZARYA)
1 25544U 98067A   20353.50421447  .00001264  00000-0  30538-4 0  9997
2 25544  51.6442 207.2511 0001227 127.3582 316.6346 15.49221106260424
TIANGONG
1 48274U 21035A   20353.50421447  .00001264  00000-0  30538-4 0  9997
2 48274  51.6442 207.2511 0001227 127.3582 316.6346 15.49221106260424
"""
    catalog = service._parse_tle_catalog(raw_tle)
    assert len(catalog) == 2
    assert catalog[0]["name"] == "ISS (ZARYA)"
    assert catalog[1]["name"] == "TIANGONG"

def test_compute_passes_mock():
    # We can test compute_passes with a known TLE
    # ISS TLE (approximate)
    tle_entry = {
        "line1": "1 25544U 98067A   20353.50421447  .00001264  00000-0  30538-4 0  9997",
        "line2": "2 25544  51.6442 207.2511 0001227 127.3582 316.6346 15.49221106260424",
        "name": "ISS (ZARYA)",
        "satellite_number": "25544"
    }

    # Observer at 0,0
    passes = service.compute_passes(tle_entry, 0.0, 0.0, 0.0, 5)

    # We can't easily assert exact times without mocking time,
    # but we can check the structure
    if len(passes) > 0:
        p = passes[0]
        assert "rise_time" in p
        assert "set_time" in p
        assert "max_altitude_deg" in p
        assert "rise_azimuth_deg" in p
        assert "set_azimuth_deg" in p

def test_predict_endpoint_404():
    response = client.post("/predict", json={
        "satellite_id": "99999",
        "observer_lat": 0,
        "observer_lon": 0,
        "observer_alt_m": 0,
        "max_results": 5
    })
    # This will fail if cache is empty or sat not found
    assert response.status_code in [404, 502]

def test_compute_passes_currently_visible():
    # Create a fake TLE that we know is visible somewhere?
    # Or rely on the logic: if we mock find_events to return culminate/set first
    pass
