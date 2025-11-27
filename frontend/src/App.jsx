import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Stars, useTexture } from "@react-three/drei";
import * as THREE from "three";
import * as satellite from "satellite.js";

const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const EARTH_RADIUS_KM = 6371;


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

  useFrame((state) => {
    if (!meshRef.current || satRecords.length === 0) {
      return;
    }
    const now = new Date();
    const gmst = satellite.gstime(now);
    const camera = state.camera;

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

      // Billboard effect: make circle face camera
      dummy.lookAt(camera.position);
      
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
      <circleGeometry args={[0.015, 8]} />
      <meshStandardMaterial
        vertexColors
        emissive="#ffffff"
        emissiveIntensity={0.5}
        toneMapped={false}
        side={THREE.DoubleSide}
      />
    </instancedMesh>
  );
}

function Hud({ catalogCount, selectedSat, passes, passState, observer }) {
  return (
    <div className="absolute top-4 left-4 bg-black/50 text-white p-4 rounded-lg backdrop-blur-md border border-slate-500/25 shadow-2xl w-80 pointer-events-auto">
      <div className="flex justify-between items-center mb-3">
        <div>
          <div className="text-xs tracking-wider uppercase text-slate-400 mb-1">Tracking catalog</div>
          <div className="text-2xl font-semibold text-slate-200">
            {catalogCount.toLocaleString()}
          </div>
        </div>
        <div className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
          observer.source === "gps" && observer.ready
            ? "bg-green-500/25 text-green-200"
            : "bg-indigo-500/25 text-indigo-200"
        }`}>
          {observer.source === "gps" && observer.ready ? "GPS locked" : "Manual coords"}
        </div>
      </div>

      <div className="mb-3.5">
        <div className="text-xs tracking-wider uppercase text-slate-400 mb-1">Observer</div>
        <div className="text-lg font-semibold text-slate-200">
          {observer.lat.toFixed(2)}°, {observer.lon.toFixed(2)}°
        </div>
        <div className="text-xs tracking-wider uppercase text-slate-400 mt-1">
          Alt {Math.round(observer.alt)} m · Reference frame UTC
        </div>
      </div>

      <div className="mb-3.5">
        <div className="text-xs tracking-wider uppercase text-slate-400 mb-1">Selection</div>
        {selectedSat ? (
          <>
            <div className="text-lg font-semibold text-slate-200">{selectedSat.name}</div>
            <div className="text-xs tracking-wider uppercase text-slate-400 mt-1">
              NORAD #{selectedSat.satellite_number}
            </div>
          </>
        ) : (
          <div className="text-xs tracking-wider uppercase text-slate-400">
            Click a satellite point to inspect passes.
          </div>
        )}
      </div>

      <div>
        <div className="text-xs tracking-wider uppercase text-slate-400 mb-1">Next passes (36h)</div>
        {passState.loading && (
          <div className="text-xs tracking-wider uppercase text-indigo-200">
            Computing windows…
          </div>
        )}
        {passState.error && (
          <div className="text-xs tracking-wider uppercase text-red-200">
            {passState.error}
          </div>
        )}
        {!passState.loading && passes.length === 0 && selectedSat && !passState.error && (
          <div className="text-xs tracking-wider uppercase text-indigo-200">
            No visible passes in the next window.
          </div>
        )}
        <div className="max-h-[220px] overflow-y-auto mt-3 pr-1 flex flex-col gap-2">
          {passes.map((passEvent) => (
            <div className="grid grid-cols-3 gap-2 p-2.5 rounded-xl bg-slate-900/75 border border-slate-700/60" key={passEvent.rise_time}>
              <div>
                <div className="text-xs tracking-wider uppercase text-slate-400 mb-1">Rise</div>
                <div className="text-lg font-semibold text-slate-200">{formatTime(passEvent.rise_time)}</div>
                <div className="text-xs tracking-wider uppercase text-slate-400">{formatDegrees(passEvent.rise_azimuth_deg)} az</div>
              </div>
              <div>
                <div className="text-xs tracking-wider uppercase text-slate-400 mb-1">Peak</div>
                <div className="text-lg font-semibold text-slate-200">{Math.round(passEvent.max_altitude_deg)}°</div>
                <div className="text-xs tracking-wider uppercase text-slate-400">{formatTime(passEvent.max_altitude_time)}</div>
              </div>
              <div>
                <div className="text-xs tracking-wider uppercase text-slate-400 mb-1">Set</div>
                <div className="text-lg font-semibold text-slate-200">{formatTime(passEvent.set_time)}</div>
                <div className="text-xs tracking-wider uppercase text-slate-400">{formatDegrees(passEvent.set_azimuth_deg)} az</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatusBanner({ message, tone }) {
  return (
    <div className={`absolute top-5 right-5 px-4 py-3 rounded-xl text-sm shadow-2xl pointer-events-none ${
      tone === "error"
        ? "bg-red-500/85 text-white"
        : "bg-blue-500/65 text-white"
    }`}>
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
    <div className="w-screen h-screen relative bg-gradient-radial from-[#112753] via-[#050b16] to-[#01040a] font-sans text-slate-50">
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
