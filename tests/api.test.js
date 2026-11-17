const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Point to an isolated test SQLite DB
const testDbPath = path.resolve(__dirname, '../data/test_smoothroute.db');
process.env.DB_PATH = testDbPath;
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test_secret_64_bytes_0123456789abcdef0123456789abcdef0123456789';
}

const { createApp } = require('../src/server');
const { closeDb } = require('../src/db/database');

let server = null;
let baseUrl = '';
let authToken = '';
let createdVehicleId = null;
let createdTripId = null;

test.before(async () => {
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  const app = createApp({ autoSeed: true });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  closeDb();
  if (fs.existsSync(testDbPath)) {
    try {
      fs.unlinkSync(testDbPath);
    } catch {}
  }
});

test('1. Health & Seeded Public Data check', async () => {
  const res = await fetch(`${baseUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.ok(body.stats.publicRoutes >= 7);
  assert.ok(body.stats.mappedHazards >= 6);
});

test('2. User Sign Up creates user account and primary calibrated Tesla vehicle', async () => {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'fsd_tester_1',
      email: 'fsd_tester@smoothroute.org',
      password: 'StrongPassword123!',
      displayName: 'Shaun FSD Tester',
      driverModePreference: 'fsd_smooth',
      fsdDriver: true,
      bodySensitivity: 'sensitive_spine',
      vehicleTemplateId: 'tesla-model-3-highland-lr'
    })
  });

  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.token);
  assert.equal(data.user.username, 'fsd_tester_1');
  assert.equal(data.user.vehicles.length, 1);
  assert.equal(data.user.vehicles[0].make, 'Tesla');
  assert.equal(data.user.vehicles[0].model, 'Model 3 (Highland)');

  authToken = data.token;
  createdVehicleId = data.user.vehicles[0].id;
});

test('3. User Login & Authenticated Profile retrieval', async () => {
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: 'fsd_tester@smoothroute.org',
      password: 'StrongPassword123!'
    })
  });
  assert.equal(loginRes.status, 200);
  const loginData = await loginRes.json();
  assert.ok(loginData.token);

  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${authToken}` }
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.user.email, 'fsd_tester@smoothroute.org');
});

test('4. Add second car to Garage & switch active car', async () => {
  const res = await fetch(`${baseUrl}/api/vehicles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      templateId: 'tesla-model-s-lr',
      nickname: 'Weekend Air Cruiser',
      isPrimary: true
    })
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.equal(data.vehicles.length, 2);
  assert.equal(data.vehicle.model, 'Model S');
  assert.equal(data.vehicle.suspensionDampingFactor, 0.78);
  createdVehicleId = data.vehicle.id;
});

test('5. Calibrate 3-Axis Phone Mount Orientation & Record G-Force Trip with Auto-Hazard Detection', async () => {
  const calRes = await fetch(`${baseUrl}/api/trips/calibrate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      samples: [
        { ax: 0.0, ay: 9.215, az: 3.354 },
        { ax: 0.01, ay: 9.21, az: 3.36 }
      ]
    })
  });
  assert.equal(calRes.status, 200);
  const calData = await calRes.json();
  assert.ok(calData.calibration.mountAngles);

  const t0 = Date.now();
  const telemetrySamples = Array.from({ length: 30 }, (_, idx) => ({
    timestampMs: t0 + idx * 100,
    lat: 37.58 - idx * 0.0005,
    lng: -122.36 + idx * 0.0004,
    gLon: idx === 15 ? -0.48 : 0.04,
    gLat: 0.05,
    gVert: idx === 8 ? 0.65 : 0.04,
    speedMph: 62
  }));

  const tripRes = await fetch(`${baseUrl}/api/trips`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      vehicleId: createdVehicleId,
      title: 'E2E Test FSD Telemetry Run',
      originName: 'Burlingame',
      destinationName: 'San Mateo',
      corridorGroup: 'sf-palo-alto',
      driveMode: 'FSD Supervised',
      publishAsRoute: true,
      autoPublishHazards: true,
      samples: telemetrySamples
    })
  });

  assert.equal(tripRes.status, 201);
  const tripData = await tripRes.json();
  assert.ok(tripData.trip.id);
  assert.ok(tripData.analysis.peakGVert >= 0.60);
  assert.ok(tripData.detectedHazards.length >= 1, 'Should detect the 0.65G pothole / -0.48G hard brake');
  assert.ok(tripData.publishedRouteId, 'Should publish route to public map');
  createdTripId = tripData.trip.id;
});

test('6. Export Recorded Trip Telemetry in CSV and GPX formats', async () => {
  const csvRes = await fetch(`${baseUrl}/api/trips/${createdTripId}/export?format=csv`);
  assert.equal(csvRes.status, 200);
  const csvText = await csvRes.text();
  assert.ok(csvText.includes('timestamp_ms,lat,lng,g_lon,g_lat,g_vert'));

  const gpxRes = await fetch(`${baseUrl}/api/trips/${createdTripId}/export?format=gpx`);
  assert.equal(gpxRes.status, 200);
  const gpxText = await gpxRes.text();
  assert.ok(gpxText.includes('<gpx') && gpxText.includes('<trkpt'));
});

test('7. FSD Smooth Route Planner & Comparator returns vehicle-specific ranked routes', async () => {
  const compRes = await fetch(`${baseUrl}/api/routes/compare`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({
      corridorGroup: 'sf-palo-alto',
      mode: 'fsd_smooth',
      templateId: 'tesla-model-3-perf'
    })
  });
  assert.equal(compRes.status, 200);
  const compData = await compRes.json();
  assert.ok(compData.recommendedRoute);
  assert.equal(compData.recommendedRoute.slug, 'i280-junipero-serra-fsd-smooth');
  assert.ok(compData.crossCarComparison.length >= 5);
});
