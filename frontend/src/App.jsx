import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars, useTexture } from "@react-three/drei";
import * as THREE from "three";
import * as satellite from "satellite.js";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const EARTH_RADIUS_KM = 6371;

const shellStyle = {
  width: "100vw",
  height: "100vh",
  position: "relative",
  background:
    "radial-gradient(circle at 20% 20%, #112753 0%, #050b16 50%, #01040a 100%)",
  fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "#f8fafc",
};

const hudStyle = {
  position: "absolute",
  top: "1.25rem",
  left: "1.25rem",
  width: "320px",
  padding: "1rem 1.25rem",
  borderRadius: "1rem",
  background: "rgba(2, 6, 23, 0.78)",
  backdropFilter: "blur(12px)",
  border: "1px solid rgba(100, 116, 139, 0.25)",
  boxShadow: "0 20px 45px rgba(2, 6, 23, 0.55)",
  pointerEvents: "auto",
};

const hudHeading = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "0.75rem",
};

const miniTextStyle = {
  fontSize: "0.75rem",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "#94a3b8",
  marginBottom: "0.15rem",
};

const valueStyle = {
  fontSize: "1.1rem",
  fontWeight: 600,
  color: "#e2e8f0",
};

const passListStyle = {
  maxHeight: "220px",
  overflowY: "auto",
  marginTop: "0.75rem",
  paddingRight: "0.25rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
};

const passRowStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: "0.5rem",
  padding: "0.6rem",
  borderRadius: "0.75rem",
  background: "rgba(15, 23, 42, 0.75)",
  border: "1px solid rgba(51, 65, 85, 0.6)",
};

const pillStyle = (tone = "neutral") => ({
  padding: "0.35rem 0.7rem",
  borderRadius: "999px",
  fontSize: "0.75rem",
  fontWeight: 600,
  background:
    tone === "positive"
      ? "rgba(34, 197, 94, 0.25)"
      : tone === "negative"
      ? "rgba(239, 68, 68, 0.25)"
      : "rgba(99, 102, 241, 0.25)",
  color:
    tone === "positive"
      ? "#a7f3d0"
      : tone === "negative"
      ? "#fecaca"
      : "#c7d2fe",
});

const statusBannerBase = {
  position: "absolute",
  top: "1.25rem",
  right: "1.25rem",
  padding: "0.75rem 1rem",
  borderRadius: "0.9rem",
  fontSize: "0.9rem",
  boxShadow: "0 20px 45px rgba(2, 6, 23, 0.55)",
  pointerEvents: "none",
};

const formatTime = (isoString) => {
  if (!isoString) return "--";
  const date = new Date(isoString);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const formatDegrees = (value) => `${Math.round(value ?? 0)}°`;

const defaultLocation = {
  lat: 0,
  lon: 0,
  alt: 0,
  ready: false,
  source: "default",
};

function useObserverLocation() {
  const [location, setLocation] = useState(defaultLocation);

  useEffect(() => {
    if (typeof window === "undefined" || !("geolocation" in navigator)) {
      setLocation((prev) => ({ ...prev, ready: true, source: "default" }));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocation({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          alt: position.coords.altitude ?? 0,
          ready: true,
          source: "gps",
        });
      },
      () => {
        setLocation((prev) => ({ ...prev, ready: true, source: "default" }));
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }, []);

  return location;
}

function Earth() {
  const texture = useTexture(
    "https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg"
  );

  return (
    <mesh>
      <sphereGeometry args={[1, 64, 64]} />
      <meshStandardMaterial map={texture} roughness={1} metalness={0.1} />
    </mesh>
  );
}

function SatelliteSwarm({ catalog, onSelect, selectedId }) {
  const meshRef = useRef();
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const satRecords = useMemo(() => {
    return catalog
      .map((sat) => {
        try {
          return {
            ...sat,
            satrec: satellite.twoline2satrec(sat.line1, sat.line2),
          };
        } catch (err) {
          console.warn(`Invalid TLE skipped for ${sat?.name}`, err);
          return null;
        }
      })
      .filter(Boolean);
  }, [catalog]);

  const baseColor = useMemo(() => new THREE.Color("#f8fafc"), []);
  const highlightColor = useMemo(() => new THREE.Color("#f97316"), []);

  useEffect(() => {
    if (!meshRef.current) return;
    meshRef.current.count = satRecords.length;
    satRecords.forEach((sat, idx) => {
      const color =
        sat.satellite_number === selectedId ? highlightColor : baseColor;
      meshRef.current.setColorAt(idx, color);
    });
    if (meshRef.current.instanceColor) {
      meshRef.current.instanceColor.needsUpdate = true;
    }
  }, [satRecords, selectedId, baseColor, highlightColor]);

  useFrame(() => {
    if (!meshRef.current || satRecords.length === 0) {
      return;
    }
    const now = new Date();
    const gmst = satellite.gstime(now);

    satRecords.forEach((sat, idx) => {
      const propagation = satellite.propagate(sat.satrec, now);
      const positionEci = propagation.position;
      if (!positionEci) return;

      const positionEcf = satellite.eciToEcf(positionEci, gmst);
      dummy.position.set(
        positionEcf.x / EARTH_RADIUS_KM,
        positionEcf.y / EARTH_RADIUS_KM,
        positionEcf.z / EARTH_RADIUS_KM
      );

      const scale = sat.satellite_number === selectedId ? 0.02 : 0.012;
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(idx, dummy.matrix);
    });

    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  const handlePointerDown = (event) => {
    event.stopPropagation();
    const instanceId = event.instanceId;
    if (instanceId === undefined) return;
    const sat = satRecords[instanceId];
    if (!sat) return;

    onSelect?.({
      name: sat.name,
      satellite_number: sat.satellite_number,
      line1: sat.line1,
      line2: sat.line2,
    });
  };

  if (!satRecords.length) {
    return null;
  }

  return (
    <instancedMesh
      ref={meshRef}
      key={satRecords.length}
      args={[undefined, undefined, satRecords.length]}
      onPointerDown={handlePointerDown}
      frustumCulled={false}
    >
      <sphereGeometry args={[0.01, 6, 6]} />
      <meshStandardMaterial
        vertexColors
        emissive="#ffffff"
        emissiveIntensity={0.5}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

function Hud({ catalogCount, selectedSat, passes, passState, observer }) {
  return (
    <div style={hudStyle}>
      <div style={hudHeading}>
        <div>
          <div style={miniTextStyle}>Tracking catalog</div>
          <div style={{ ...valueStyle, fontSize: "1.4rem" }}>
            {catalogCount.toLocaleString()}
          </div>
        </div>
        <div style={pillStyle(observer.source === "gps" ? "positive" : "neutral")}>
          {observer.source === "gps" && observer.ready ? "GPS locked" : "Manual coords"}
        </div>
      </div>

      <div style={{ marginBottom: "0.85rem" }}>
        <div style={miniTextStyle}>Observer</div>
        <div style={valueStyle}>
          {observer.lat.toFixed(2)}°, {observer.lon.toFixed(2)}°
        </div>
        <div style={{ ...miniTextStyle, marginTop: "0.15rem" }}>
          Alt {Math.round(observer.alt)} m · Reference frame UTC
        </div>
      </div>

      <div style={{ marginBottom: "0.85rem" }}>
        <div style={miniTextStyle}>Selection</div>
        {selectedSat ? (
          <>
            <div style={valueStyle}>{selectedSat.name}</div>
            <div style={{ ...miniTextStyle, marginTop: "0.2rem" }}>
              NORAD #{selectedSat.satellite_number}
            </div>
          </>
        ) : (
          <div style={miniTextStyle}>Click a satellite point to inspect passes.</div>
        )}
      </div>

      <div>
        <div style={miniTextStyle}>Next passes (36h)</div>
        {passState.loading && (
          <div style={{ ...miniTextStyle, color: "#cbd5f5" }}>
            Computing windows…
          </div>
        )}
        {passState.error && (
          <div style={{ ...miniTextStyle, color: "#fecaca" }}>
            {passState.error}
          </div>
        )}
        {!passState.loading && passes.length === 0 && selectedSat && !passState.error && (
          <div style={{ ...miniTextStyle, color: "#cbd5f5" }}>
            No visible passes in the next window.
          </div>
        )}
        <div style={passListStyle}>
          {passes.map((passEvent) => (
            <div style={passRowStyle} key={passEvent.rise_time}>
              <div>
                <div style={miniTextStyle}>Rise</div>
                <div style={valueStyle}>{formatTime(passEvent.rise_time)}</div>
                <div style={miniTextStyle}>{formatDegrees(passEvent.rise_azimuth_deg)} az</div>
              </div>
              <div>
                <div style={miniTextStyle}>Peak</div>
                <div style={valueStyle}>{Math.round(passEvent.max_altitude_deg)}°</div>
                <div style={miniTextStyle}>{formatTime(passEvent.max_altitude_time)}</div>
              </div>
              <div>
                <div style={miniTextStyle}>Set</div>
                <div style={valueStyle}>{formatTime(passEvent.set_time)}</div>
                <div style={miniTextStyle}>{formatDegrees(passEvent.set_azimuth_deg)} az</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ message, tone }) {
  const background =
    tone === "error"
      ? "rgba(239, 68, 68, 0.85)"
      : "rgba(59, 130, 246, 0.65)";
  return (
    <div style={{ ...statusBannerBase, background }}>
      {message}
    </div>
  );
}

export default function App() {
  const [catalog, setCatalog] = useState([]);
  const [catalogState, setCatalogState] = useState({ loading: true, error: null });
  const [selectedSat, setSelectedSat] = useState(null);
  const [passes, setPasses] = useState([]);
  const [passState, setPassState] = useState({ loading: false, error: null });
  const observer = useObserverLocation();

  useEffect(() => {
    const controller = new AbortController();
    setCatalogState({ loading: true, error: null });

    fetch(`${API_BASE_URL}/tles`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`TLE fetch failed (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        setCatalog(data?.satellites ?? []);
        setCatalogState({ loading: false, error: null });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setCatalogState({ loading: false, error: err.message });
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedSat) {
      setPasses([]);
      return;
    }

    const controller = new AbortController();
    setPassState({ loading: true, error: null });

    fetch(`${API_BASE_URL}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        satellite_id: selectedSat.satellite_number,
        observer_lat: observer.lat,
        observer_lon: observer.lon,
        observer_alt_m: observer.alt,
        max_results: 5,
      }),
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Prediction failed (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        setPasses(data?.passes ?? []);
        setPassState({ loading: false, error: null });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setPassState({ loading: false, error: err.message });
      });

    return () => controller.abort();
  }, [selectedSat, observer.lat, observer.lon, observer.alt]);

  return (
    <div style={shellStyle}>
      <Canvas
        camera={{ position: [0, 0, 4], fov: 55 }}
        gl={{ antialias: true }}
        dpr={[1, 2]}
        shadows
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 3, 5]} intensity={1.2} />
        <Suspense fallback={null}>
          <Earth />
        </Suspense>
        <SatelliteSwarm
          catalog={catalog}
          selectedId={selectedSat?.satellite_number}
          onSelect={setSelectedSat}
        />
        <Stars radius={200} depth={60} count={2000} factor={4} fade speed={1} />
        <OrbitControls
          enablePan={false}
          enableDamping
          dampingFactor={0.05}
          minDistance={1.5}
          maxDistance={10}
        />
      </Canvas>

      <Hud
        catalogCount={catalog.length}
        selectedSat={selectedSat}
        passes={passes}
        passState={passState}
        observer={observer}
      />

      {catalogState.loading && (
        <StatusBanner message="Loading active TLE catalog…" tone="info" />
      )}
      {catalogState.error && (
        <StatusBanner message={catalogState.error} tone="error" />
      )}
    </div>
  );
}
