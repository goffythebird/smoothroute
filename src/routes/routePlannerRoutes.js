/**
 * SmoothRoute — Public Routes, Tesla FSD Smooth Route Planner, Hazards & Analytics API
 */

const express = require('express');
const { getDb } = require('../db/database');
const { optionalAuth, requireAuth } = require('../middleware/authMiddleware');
const {
  VEHICLE_TEMPLATES,
  predictRouteForVehicle,
  rankRoutesForDriver
} = require('../physics/gforceEngine');

const router = express.Router();

function formatRouteRow(row) {
  let waypoints = [];
  try {
    waypoints = row.waypoints_json ? JSON.parse(row.waypoints_json) : [];
  } catch {
    waypoints = [];
  }
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
  // Default reference: Tesla Model Y Long Range
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
 * Compare routes in a corridor (or matching origin/destination) tailored to a specific car and FSD/Smoothness priority
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

  // Also show cross-car comparison for the recommended route across popular Tesla & EV models
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
 * Report a new G-force road hazard on the public map
 */
router.post('/hazards', requireAuth, (req, res) => {
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
      speedMph = 45
    } = req.body || {};

    if (!label || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'Hazard label, latitude (lat), and longitude (lng) are required.' });
    }

    const userVeh = db
      .prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY is_primary DESC LIMIT 1')
      .get(req.user.userId);
    const vehicleLabel = userVeh
      ? `${userVeh.year} ${userVeh.make} ${userVeh.model}`
      : 'Community Driver';

    const result = db.prepare(`
      INSERT INTO hazards (
        route_id, reported_by_user_id, vehicle_label,
        type, severity, label, description, road_name,
        lat, lng, peak_g, vertical_g, lateral_g, longitudinal_g,
        normalized_severity_g, speed_mph, confirmations
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      routeId ? Number(routeId) : null,
      req.user.userId,
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

  // Vehicle suspension G-isolation benchmark across standard reference rough road (0.12G RMS / 0.50G peak road input)
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
