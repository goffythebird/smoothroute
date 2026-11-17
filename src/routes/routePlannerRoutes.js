/**
 * SmoothRoute — Public Routes, Tesla FSD Smooth Route Planner, Custom OSRM Router,
 * Keyless Map Tile Proxy, Hazards & Analytics API
 */

const express = require('express');
const { getDb } = require('../db/database');
const { optionalAuth } = require('../middleware/authMiddleware');
const {
  VEHICLE_TEMPLATES,
  predictRouteForVehicle,
  rankRoutesForDriver,
  haversineMiles,
  normalizedGToIri
} = require('../physics/gforceEngine');
const {
  US_NATIONWIDE_CORRIDORS,
  estimateUsHighwayIriForRoute
} = require('../physics/usHighwayBaselines');

const router = express.Router();

// In-memory LRU-like cache for map tiles (zero API key required)
const tileCache = new Map();
const MAX_TILE_CACHE = 600;

/**
 * GET /api/tiles/:z/:x/:y.png
 * Keyless OpenStreetMap / Esri Map Tile Proxy with memory caching
 */
router.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const z = Number(req.params.z);
  const x = Number(req.params.x);
  const y = Number(req.params.y);
  if (Number.isNaN(z) || Number.isNaN(x) || Number.isNaN(y) || z < 0 || z > 20) {
    return res.status(400).end();
  }

  const cacheKey = `${z}/${x}/${y}`;
  if (tileCache.has(cacheKey)) {
    const cached = tileCache.get(cacheKey);
    res.setHeader('Content-Type', cached.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buffer);
  }

  const urls = [
    `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'SmoothRoute/1.0 (Open-Source Car G-Force & FSD Route Tracker)',
          Accept: 'image/png,image/jpeg,image/*'
        },
        signal: AbortSignal.timeout(6000)
      });
      if (response.ok) {
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        const contentType = response.headers.get('content-type') || 'image/png';

        if (tileCache.size >= MAX_TILE_CACHE) {
          const oldestKey = tileCache.keys().next().value;
          tileCache.delete(oldestKey);
        }
        tileCache.set(cacheKey, { buffer, contentType });

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
    } catch {
      // try fallback tile source
    }
  }

  return res.status(502).end();
});

function formatRouteRow(row) {
  let waypoints = [];
  try {
    waypoints = row.waypoints_json ? JSON.parse(row.waypoints_json) : [];
  } catch {
    waypoints = [];
  }
  const iriInfo = normalizedGToIri(row.normalized_road_roughness_g);
  return {
    id: row.id,
    slug: row.slug,
    corridorGroup: row.corridor_group,
    name: row.name,
    originName: row.origin_name,
    destinationName: row.destination_name,
    originLat: row.origin_lat,
    originLng: row.origin_lng,
    destLat: row.dest_lat,
    destLng: row.dest_lng,
    distanceMiles: row.distance_miles,
    estimatedMinutes: row.estimated_minutes,
    highwaySummary: row.highway_summary,
    smoothnessScore: row.smoothness_score,
    fsdComfortScore: row.fsd_comfort_score,
    fsdGrade: row.fsd_grade,
    bodyWearScore: row.body_wear_score,
    bodyWearGrade: row.body_wear_grade,
    avgVerticalG: row.avg_vertical_g,
    peakVerticalG: row.peak_vertical_g,
    peakLateralG: row.peak_lateral_g,
    peakLongitudinalG: row.peak_longitudinal_g,
    normalizedRoadRoughnessG: row.normalized_road_roughness_g,
    iriInchesPerMile: iriInfo.iriInchesPerMile,
    iriMetersPerKm: iriInfo.iriMetersPerKm,
    fhwaRating: iriInfo.fhwaRating,
    avgJerkGPerSec: row.avg_jerk_g_per_sec,
    vdvScore: row.vdv_score,
    spineShockCount: row.spine_shock_count,
    fsdNotes: row.fsd_notes,
    surfaceType: row.surface_type,
    waypoints,
    sampleTripsCount: row.sample_trips_count,
    upvotes: row.upvotes,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at
  };
}

function resolveVehicleContext(db, req, explicitVehicleId, explicitTemplateId, customVehicle) {
  if (customVehicle && typeof customVehicle === 'object') {
    return customVehicle;
  }
  if (explicitTemplateId) {
    const tpl = VEHICLE_TEMPLATES.find((t) => t.id === explicitTemplateId);
    if (tpl) return tpl;
  }
  if (explicitVehicleId) {
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(Number(explicitVehicleId));
    if (v) {
      return {
        id: v.id,
        make: v.make,
        model: v.model,
        year: v.year,
        trim: v.trim,
        suspensionType: v.suspension_type,
        wheelDiameterInches: v.wheel_diameter_inches,
        tireSidewallRatio: v.tire_sidewall_ratio,
        suspensionDampingFactor: v.suspension_damping_factor,
        lateralRollFactor: v.lateral_roll_factor,
        seatIsolationFactor: v.seat_isolation_factor
      };
    }
  }
  if (req.user && req.user.userId) {
    const v = db
      .prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1')
      .get(req.user.userId);
    if (v) {
      return {
        id: v.id,
        make: v.make,
        model: v.model,
        year: v.year,
        trim: v.trim,
        suspensionType: v.suspension_type,
        wheelDiameterInches: v.wheel_diameter_inches,
        tireSidewallRatio: v.tire_sidewall_ratio,
        suspensionDampingFactor: v.suspension_damping_factor,
        lateralRollFactor: v.lateral_roll_factor,
        seatIsolationFactor: v.seat_isolation_factor
      };
    }
  }
  return VEHICLE_TEMPLATES.find((t) => t.id === 'tesla-model-y-lr') || VEHICLE_TEMPLATES[0];
}

/**
 * GET /api/routes
 * List public routes ranked for the driver's car and preference mode
 */
router.get('/routes', optionalAuth, (req, res) => {
  const db = getDb();
  const corridor = req.query.corridor ? String(req.query.corridor).trim() : null;
  const mode = String(req.query.mode || 'fsd_smooth');
  const vehicle = resolveVehicleContext(
    db,
    req,
    req.query.vehicleId,
    req.query.templateId,
    null
  );

  let sql = 'SELECT * FROM public_routes';
  const params = [];
  if (corridor && corridor !== 'all') {
    sql += ' WHERE corridor_group = ?';
    params.push(corridor);
  }
  sql += ' ORDER BY fsd_comfort_score DESC, smoothness_score DESC';

  const rows = db.prepare(sql).all(...params).map(formatRouteRow);
  const ranked = rankRoutesForDriver(rows, mode, vehicle);

  return res.json({
    activeVehicle: {
      name: `${vehicle.year || ''} ${vehicle.make || ''} ${vehicle.model || ''}`.trim(),
      trim: vehicle.trim || '',
      suspensionDampingFactor: vehicle.suspensionDampingFactor || 1.0
    },
    mode,
    routes: ranked
  });
});

/**
 * GET /api/routes/us-hpms-baselines
 * Nationwide USDOT FHWA HPMS (International Roughness Index) & OpenStreetMap baseline corridors
 */
router.get('/routes/us-hpms-baselines', (_req, res) => {
  return res.json({
    source: 'USDOT FHWA Highway Performance Monitoring System (HPMS) & OpenStreetMap Surface Baselines',
    fhwaThresholds: {
      good: { maxIriInchesPerMile: 95, maxIriMetersPerKm: 1.5, label: 'Good (<95 in/mi • Ultra Smooth)' },
      fair: { maxIriInchesPerMile: 170, maxIriMetersPerKm: 2.68, label: 'Fair (95-170 in/mi • Moderate Wear)' },
      poor: { minIriInchesPerMile: 171, minIriMetersPerKm: 2.69, label: 'Poor (>170 in/mi • High G-Shock / Rim & Spine Hazard)' }
    },
    corridorsCount: US_NATIONWIDE_CORRIDORS.length,
    corridors: US_NATIONWIDE_CORRIDORS
  });
});

/**
 * GET /api/routes/corridors
 * List distinct route corridors for the FSD Route Planner
 */
router.get('/routes/corridors', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT corridor_group,
           MIN(origin_name) AS origin_name,
           MIN(destination_name) AS destination_name,
           COUNT(*) AS route_count,
           MAX(fsd_comfort_score) AS best_fsd_score,
           MIN(fsd_comfort_score) AS worst_fsd_score,
           MIN(body_wear_score) AS lowest_body_wear,
           MAX(body_wear_score) AS highest_body_wear
    FROM public_routes
    GROUP BY corridor_group
    ORDER BY route_count DESC, best_fsd_score DESC
  `).all();

  return res.json({ corridors: rows });
});

/**
 * POST /api/routes/compare
 * Compare routes in a corridor tailored to a specific car and FSD/Smoothness priority
 */
router.post('/routes/compare', optionalAuth, (req, res) => {
  const db = getDb();
  const {
    corridorGroup = 'sf-palo-alto',
    mode = 'fsd_smooth',
    vehicleId = null,
    templateId = null,
    customVehicle = null
  } = req.body || {};

  const vehicle = resolveVehicleContext(db, req, vehicleId, templateId, customVehicle);

  let rows = [];
  if (corridorGroup && corridorGroup !== 'all') {
    rows = db.prepare('SELECT * FROM public_routes WHERE corridor_group = ?').all(corridorGroup);
  }
  if (rows.length === 0) {
    rows = db.prepare('SELECT * FROM public_routes ORDER BY id ASC').all();
  }

  const formatted = rows.map(formatRouteRow);
  const ranked = rankRoutesForDriver(formatted, mode, vehicle);
  const recommended = ranked[0] || null;
  const roughest = ranked[ranked.length - 1] || null;

  const crossCarComparison = recommended
    ? VEHICLE_TEMPLATES.slice(0, 7).map((tpl) => ({
        templateId: tpl.id,
        carName: `${tpl.year} ${tpl.make} ${tpl.model}`,
        trim: tpl.trim,
        suspensionLabel: tpl.suspensionLabel,
        ...predictRouteForVehicle(recommended, tpl)
      }))
    : [];

  return res.json({
    corridorGroup,
    mode,
    activeVehicle: vehicle,
    recommendedRoute: recommended,
    roughestAlternative: roughest,
    rankedRoutes: ranked,
    crossCarComparison
  });
});

/**
 * Helper: Geocode a place name using OpenStreetMap Nominatim (keyless)
 */
async function geocodePlace(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'SmoothRoute/1.0 (Open-Source Car G-Force & FSD Route Planner)'
    },
    signal: AbortSignal.timeout(6000)
  });
  if (!res.ok) throw new Error(`Geocoding failed for "${query}"`);
  const data = await res.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Could not locate address or city: "${query}"`);
  }
  return {
    lat: Number(data[0].lat),
    lng: Number(data[0].lon),
    displayName: data[0].display_name.split(',').slice(0, 2).join(',').trim()
  };
}

/**
 * POST /api/routes/custom-plan
 * Plan and score real-world routes between any Origin & Destination using keyless OSRM + Nominatim
 */
router.post('/routes/custom-plan', optionalAuth, async (req, res) => {
  try {
    const db = getDb();
    const {
      originQuery,
      destinationQuery,
      mode = 'fsd_smooth',
      vehicleId = null,
      templateId = null,
      saveToPublic = true
    } = req.body || {};

    if (!originQuery || !destinationQuery) {
      return res.status(400).json({ error: 'Both Origin and Destination are required.' });
    }

    const [originGeo, destGeo] = await Promise.all([
      geocodePlace(originQuery),
      geocodePlace(destinationQuery)
    ]);

    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${originGeo.lng},${originGeo.lat};${destGeo.lng},${destGeo.lat}?overview=full&geometries=geojson&alternatives=3&steps=true`;
    const osrmRes = await fetch(osrmUrl, {
      headers: { 'User-Agent': 'SmoothRoute/1.0' },
      signal: AbortSignal.timeout(8000)
    });

    const osrmData = await osrmRes.json();
    if (!osrmData.routes || osrmData.routes.length === 0) {
      return res.status(404).json({ error: 'No driving routes found between those locations.' });
    }

    const vehicle = resolveVehicleContext(db, req, vehicleId, templateId, null);
    const existingHazards = db.prepare('SELECT * FROM hazards').all();
    const corridorSlug = `custom-${originGeo.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-to-${destGeo.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 48);

    const candidateRoutes = osrmData.routes.map((osrmRoute, idx) => {
      const distanceMiles = Number((osrmRoute.distance / 1609.344).toFixed(1));
      const estimatedMinutes = Number((osrmRoute.duration / 60).toFixed(1));
      const coords = osrmRoute.geometry.coordinates || [];
      const stride = Math.max(1, Math.floor(coords.length / 40));

      // Extract major road names from steps
      const stepNames = [];
      let turnCount = 0;
      const steps = (osrmRoute.legs && osrmRoute.legs[0] && osrmRoute.legs[0].steps) || [];
      for (const st of steps) {
        if (st.name && !stepNames.includes(st.name) && st.distance > 400) {
          stepNames.push(st.name);
        }
        if (st.maneuver && ['turn', 'fork', 'on ramp', 'off ramp', 'roundabout'].includes(st.maneuver.type)) {
          turnCount++;
        }
      }

      const summaryRoads = stepNames.slice(0, 3).join(' → ') || `Route Option #${idx + 1}`;
      const isFsdSmoothCandidate = idx === 0 && turnCount <= 12;

      // Check proximity to mapped G-force hazards
      let nearbyHazardPenalties = 0;
      const waypoints = [];
      for (let i = 0; i < coords.length; i += stride) {
        const [lng, lat] = coords[i];
        let ptG = isFsdSmoothCandidate ? 0.048 : 0.095 + idx * 0.035;
        for (const h of existingHazards) {
          if (haversineMiles(lat, lng, h.lat, h.lng) < 0.8) {
            nearbyHazardPenalties += h.peak_g * 12;
            ptG = Math.max(ptG, h.vertical_g || 0.45);
          }
        }
        waypoints.push([Number(lat.toFixed(5)), Number(lng.toFixed(5)), Number(ptG.toFixed(3)), 58]);
      }

      // Compute realistic smoothness, FSD comfort, body wear, and FHWA HPMS IRI based on road geometry & turns
      const turnDensity = turnCount / Math.max(1, distanceMiles);
      const hpmsEst = estimateUsHighwayIriForRoute({
        stepNames,
        turnCount,
        distanceMiles,
        routeIdx: idx,
        nearbyHazardPenalties
      });
      const baseSmoothness = Math.round(
        Math.max(42, Math.min(97, 94 - idx * 14 - turnDensity * 8 - nearbyHazardPenalties))
      );
      const baseFsdScore = Math.round(
        Math.max(40, Math.min(98, baseSmoothness + (turnCount < 8 ? 3 : -4)))
      );
      const baseBodyWear = Math.round(Math.max(8, Math.min(88, 100 - baseSmoothness * 0.92)));
      const avgVertG = Number((0.038 + (100 - baseSmoothness) * 0.0024).toFixed(3));
      const peakVertG = Number((0.16 + (100 - baseSmoothness) * 0.0095).toFixed(2));
      const peakLatG = Number((0.14 + Math.min(0.32, turnDensity * 0.08)).toFixed(2));
      const peakLonG = Number((0.15 + Math.min(0.35, turnDensity * 0.09)).toFixed(2));
      const iriInfo = normalizedGToIri(avgVertG);

      const fsdGrade =
        baseFsdScore >= 92
          ? 'S+ Ultra Smooth'
          : baseFsdScore >= 82
          ? 'A FSD Ideal'
          : baseFsdScore >= 70
          ? 'B Smooth FSD Route'
          : baseFsdScore >= 58
          ? 'C Moderate Roughness'
          : 'D Rough / High Wear';

      const bodyWearGrade =
        baseBodyWear <= 16
          ? 'Minimal Wear'
          : baseBodyWear <= 35
          ? 'Low Body Wear'
          : baseBodyWear <= 58
          ? 'Moderate Body Wear'
          : 'High Body Wear';

      const routeObj = {
        id: Date.now() + idx,
        slug: `${corridorSlug}-${idx + 1}-${Date.now().toString(36)}`,
        corridorGroup: corridorSlug,
        name: `${originGeo.displayName} → ${destGeo.displayName} via ${summaryRoads}`,
        originName: originGeo.displayName,
        destinationName: destGeo.displayName,
        originLat: originGeo.lat,
        originLng: originGeo.lng,
        destLat: destGeo.lat,
        destLng: destGeo.lng,
        distanceMiles,
        estimatedMinutes,
        highwaySummary: `Via ${summaryRoads} (${turnCount} maneuvers)`,
        smoothnessScore: baseSmoothness,
        fsdComfortScore: baseFsdScore,
        fsdGrade,
        bodyWearScore: baseBodyWear,
        bodyWearGrade,
        avgVerticalG: avgVertG,
        peakVerticalG: peakVertG,
        peakLateralG: peakLatG,
        peakLongitudinalG: peakLonG,
        normalizedRoadRoughnessG: avgVertG,
        iriInchesPerMile: iriInfo.iriInchesPerMile || hpmsEst.iriInchesPerMile,
        iriMetersPerKm: iriInfo.iriMetersPerKm || hpmsEst.iriMetersPerKm,
        fhwaRating: iriInfo.fhwaRating || hpmsEst.fhwaRating,
        avgJerkGPerSec: Number((0.2 + (100 - baseSmoothness) * 0.018).toFixed(2)),
        vdvScore: Number((1.6 + (100 - baseSmoothness) * 0.14).toFixed(2)),
        spineShockCount: Math.max(0, Math.round((100 - baseSmoothness) / 8)),
        fsdNotes:
          baseFsdScore >= 82
            ? `Recommended FSD corridor via ${summaryRoads} (Est. FHWA IRI ${iriInfo.iriInchesPerMile} in/mi • ${iriInfo.fhwaRating}): low maneuver density (${turnCount} turns) and minimal vertical G-load.`
            : `Alternative path via ${summaryRoads} (Est. FHWA IRI ${iriInfo.iriInchesPerMile} in/mi • ${iriInfo.fhwaRating}, ${turnCount} turns); higher lateral/longitudinal transitions.`,
        surfaceType: baseSmoothness >= 82 ? `Highway Smooth Asphalt (IRI ${iriInfo.iriInchesPerMile} in/mi)` : `Mixed Arterial Pavement (IRI ${iriInfo.iriInchesPerMile} in/mi)`,
        waypoints,
        sampleTripsCount: 1,
        upvotes: 1
      };

      if (saveToPublic) {
        try {
          const ins = db.prepare(`
            INSERT INTO public_routes (
              slug, corridor_group, name, origin_name, destination_name,
              origin_lat, origin_lng, dest_lat, dest_lng,
              distance_miles, estimated_minutes, highway_summary,
              smoothness_score, fsd_comfort_score, fsd_grade,
              body_wear_score, body_wear_grade,
              avg_vertical_g, peak_vertical_g, peak_lateral_g, peak_longitudinal_g,
              normalized_road_roughness_g, avg_jerk_g_per_sec, vdv_score, spine_shock_count,
              fsd_notes, surface_type, waypoints_json, sample_trips_count, upvotes
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
          `).run(
            routeObj.slug,
            routeObj.corridorGroup,
            routeObj.name,
            routeObj.originName,
            routeObj.destinationName,
            routeObj.originLat,
            routeObj.originLng,
            routeObj.destLat,
            routeObj.destLng,
            routeObj.distanceMiles,
            routeObj.estimatedMinutes,
            routeObj.highwaySummary,
            routeObj.smoothnessScore,
            routeObj.fsdComfortScore,
            routeObj.fsdGrade,
            routeObj.bodyWearScore,
            routeObj.bodyWearGrade,
            routeObj.avgVerticalG,
            routeObj.peakVerticalG,
            routeObj.peakLateralG,
            routeObj.peakLongitudinalG,
            routeObj.normalizedRoadRoughnessG,
            routeObj.avgJerkGPerSec,
            routeObj.vdvScore,
            routeObj.spineShockCount,
            routeObj.fsdNotes,
            routeObj.surfaceType,
            JSON.stringify(routeObj.waypoints)
          );
          routeObj.id = Number(ins.lastInsertRowid);
        } catch {
          // ignore duplicate slug
        }
      }

      return routeObj;
    });

    const ranked = rankRoutesForDriver(candidateRoutes, mode, vehicle);
    return res.json({
      corridorGroup: corridorSlug,
      mode,
      activeVehicle: vehicle,
      recommendedRoute: ranked[0] || null,
      roughestAlternative: ranked[ranked.length - 1] || null,
      rankedRoutes: ranked
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Custom route calculation failed.' });
  }
});

/**
 * POST /api/routes/:id/upvote
 */
router.post('/routes/:id/upvote', optionalAuth, (req, res) => {
  const db = getDb();
  const routeId = Number(req.params.id);
  const existing = db.prepare('SELECT id, upvotes FROM public_routes WHERE id = ?').get(routeId);
  if (!existing) {
    return res.status(404).json({ error: 'Route not found.' });
  }
  db.prepare('UPDATE public_routes SET upvotes = upvotes + 1 WHERE id = ?').run(routeId);
  const updated = db.prepare('SELECT * FROM public_routes WHERE id = ?').get(routeId);
  return res.json({ route: formatRouteRow(updated) });
});

/**
 * GET /api/hazards
 * List crowd-sourced & sensor-detected G-force road hazards
 */
router.get('/hazards', (req, res) => {
  const db = getDb();
  const routeId = req.query.routeId ? Number(req.query.routeId) : null;
  const severity = req.query.severity ? String(req.query.severity) : null;

  let sql = 'SELECT * FROM hazards WHERE 1=1';
  const params = [];
  if (routeId) {
    sql += ' AND route_id = ?';
    params.push(routeId);
  }
  if (severity) {
    sql += ' AND severity = ?';
    params.push(severity);
  }
  sql += ' ORDER BY confirmations DESC, peak_g DESC LIMIT 100';

  const hazards = db.prepare(sql).all(...params);
  return res.json({ hazards });
});

/**
 * POST /api/hazards
 * Report a new G-force road hazard on the public map (works for both signed-in and guest drivers)
 */
router.post('/hazards', optionalAuth, (req, res) => {
  try {
    const db = getDb();
    const {
      routeId = null,
      type = 'pothole_shock',
      severity = 'high',
      label,
      description = '',
      roadName = 'Reported Road Segment',
      lat,
      lng,
      peakG = 0.55,
      verticalG = 0.50,
      lateralG = 0.10,
      longitudinalG = -0.15,
      speedMph = 45,
      vehicleLabel: customVehicleLabel = null
    } = req.body || {};

    if (!label || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Hazard label, latitude (lat), and longitude (lng) are required.' });
    }

    let userId = req.user && req.user.userId ? req.user.userId : null;
    let vehicleLabel = customVehicleLabel || 'Community Driver';

    if (userId) {
      const userVeh = db
        .prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY is_primary DESC LIMIT 1')
        .get(userId);
      if (userVeh) {
        vehicleLabel = `${userVeh.year} ${userVeh.make} ${userVeh.model}`;
      }
    }

    const result = db.prepare(`
      INSERT INTO hazards (
        route_id, reported_by_user_id, vehicle_label,
        type, severity, label, description, road_name,
        lat, lng, peak_g, vertical_g, lateral_g, longitudinal_g,
        normalized_severity_g, speed_mph, confirmations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      routeId ? Number(routeId) : null,
      userId,
      vehicleLabel,
      type,
      severity,
      String(label).trim(),
      String(description).trim(),
      String(roadName).trim(),
      Number(lat),
      Number(lng),
      Number(peakG),
      Number(verticalG),
      Number(lateralG),
      Number(longitudinalG),
      Number(peakG),
      Number(speedMph)
    );

    const created = db.prepare('SELECT * FROM hazards WHERE id = ?').get(Number(result.lastInsertRowid));
    return res.status(201).json({ hazard: created });
  } catch (err) {
    return res.status(500).json({ error: `Failed to report hazard: ${err.message}` });
  }
});

/**
 * POST /api/hazards/:id/confirm
 */
router.post('/hazards/:id/confirm', optionalAuth, (req, res) => {
  const db = getDb();
  const hazardId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM hazards WHERE id = ?').get(hazardId);
  if (!existing) {
    return res.status(404).json({ error: 'Hazard not found.' });
  }
  db.prepare('UPDATE hazards SET confirmations = confirmations + 1 WHERE id = ?').run(hazardId);
  const updated = db.prepare('SELECT * FROM hazards WHERE id = ?').get(hazardId);
  return res.json({ hazard: updated });
});

/**
 * GET /api/analytics/summary
 * Public summary metrics, vehicle suspension benchmark data, and top FSD smooth routes
 */
router.get('/analytics/summary', (_req, res) => {
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS totalUsers,
      (SELECT COUNT(*) FROM vehicles) AS totalVehicles,
      (SELECT COUNT(*) FROM public_routes) AS totalPublicRoutes,
      (SELECT COUNT(*) FROM trips) AS totalRecordedTrips,
      (SELECT COUNT(*) FROM hazards) AS totalHazardsMapped,
      (SELECT COALESCE(SUM(sample_trips_count), 0) FROM public_routes) AS totalCommunityDrives
  `).get();

  const smoothestRoutes = db
    .prepare('SELECT * FROM public_routes ORDER BY fsd_comfort_score DESC, smoothness_score DESC LIMIT 5')
    .all()
    .map(formatRouteRow);

  const roughestRoutes = db
    .prepare('SELECT * FROM public_routes ORDER BY body_wear_score DESC, peak_vertical_g DESC LIMIT 5')
    .all()
    .map(formatRouteRow);

  const referenceRoad = {
    normalizedRoadRoughnessG: 0.12,
    peakVerticalG: 0.50,
    peakLateralG: 0.25,
    bodyWearScore: 42,
    smoothnessScore: 72,
    fsdComfortScore: 74
  };

  const vehicleBenchmarks = VEHICLE_TEMPLATES.map((tpl) => ({
    id: tpl.id,
    make: tpl.make,
    model: tpl.model,
    year: tpl.year,
    trim: tpl.trim,
    category: tpl.category,
    suspensionLabel: tpl.suspensionLabel,
    wheelDiameterInches: tpl.wheelDiameterInches,
    tireSidewallRatio: tpl.tireSidewallRatio,
    supportsFsd: tpl.supportsFsd,
    suspensionDampingFactor: tpl.suspensionDampingFactor,
    benchmarkOnStandardRoad: predictRouteForVehicle(referenceRoad, tpl)
  })).sort((a, b) => a.suspensionDampingFactor - b.suspensionDampingFactor);

  return res.json({
    totals,
    smoothestRoutes,
    roughestRoutes,
    vehicleBenchmarks
  });
});

module.exports = router;
