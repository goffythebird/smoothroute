/**
 * SmoothRoute — Trip Telemetry Recording, Biomechanical Analysis & Export Routes
 */

const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth, optionalAuth } = require('../middleware/authMiddleware');
const {
  calibrateMountOrientation,
  transformPhoneToVehicleG,
  analyzeTripBiomechanics,
  detectGForceHazards
} = require('../physics/gforceEngine');

const router = express.Router();

function formatTripRow(row, includeTelemetry = false) {
  if (!row) return null;
  let telemetry = [];
  if (includeTelemetry && row.telemetry_summary_json) {
    try {
      telemetry = JSON.parse(row.telemetry_summary_json);
    } catch {
      telemetry = [];
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    driverName: row.driver_name || row.username || 'Driver',
    vehicleId: row.vehicle_id,
    vehicleLabel: row.vehicle_make
      ? `${row.vehicle_year || ''} ${row.vehicle_make} ${row.vehicle_model}`.trim()
      : 'Standard Vehicle',
    vehicleTrim: row.vehicle_trim || '',
    suspensionType: row.suspension_type || 'coil_standard',
    suspensionDampingFactor: row.suspension_damping_factor || 1.0,
    publicRouteId: row.public_route_id,
    title: row.title,
    originName: row.origin_name,
    destinationName: row.destination_name,
    driveMode: row.drive_mode,
    phoneMountType: row.phone_mount_type,
    status: row.status,
    isPublic: Boolean(row.is_public),
    sampleCount: row.sample_count,
    durationSec: row.duration_sec,
    distanceMiles: row.distance_miles,
    peakGLon: row.peak_g_lon,
    peakGLat: row.peak_g_lat,
    peakGVert: row.peak_g_vert,
    peakGTotal: row.peak_g_total,
    avgDynamicG: row.avg_dynamic_g,
    rmsGVert: row.rms_g_vert,
    normalizedRoadRoughnessG: row.normalized_road_roughness_g,
    peakJerkGPerSec: row.peak_jerk,
    avgJerkGPerSec: row.avg_jerk,
    isoWeightedRmsMps2: row.iso_weighted_rms,
    vibrationDoseValueVdv: row.vdv,
    spineMicroShocksCount: row.spine_micro_shocks,
    severeShockCount: row.severe_shocks,
    hardBrakeCount: row.hard_brakes,
    bodyWearScore: row.body_wear_score,
    bodyWearGrade: row.body_wear_grade,
    smoothnessScore: row.smoothness_score,
    fsdComfortScore: row.fsd_comfort_score,
    fsdGrade: row.fsd_grade,
    fsdRecommendation: row.fsd_recommendation,
    notes: row.notes,
    createdAt: row.created_at,
    ...(includeTelemetry ? { telemetry } : {})
  };
}

/**
 * POST /api/trips/calibrate
 * Calibrate 3-axis phone accelerometer mount orientation from stationary gravity samples
 */
router.post('/calibrate', optionalAuth, (req, res) => {
  try {
    const { samples } = req.body || {};
    const calibration = calibrateMountOrientation(samples);

    if (req.user && req.user.userId) {
      const db = getDb();
      db.prepare('UPDATE users SET calibration_json = ? WHERE id = ?').run(
        JSON.stringify(calibration),
        req.user.userId
      );
    }

    return res.json({
      calibration,
      message: `Phone mount calibrated (${calibration.mountAngles.pitchDeg}° pitch, ${calibration.mountAngles.rollDeg}° roll).`
    });
  } catch (err) {
    return res.status(500).json({ error: `Calibration failed: ${err.message}` });
  }
});

/**
 * GET /api/trips
 * List public trips or authenticated user's trips
 */
router.get('/', optionalAuth, (req, res) => {
  const db = getDb();
  const mineOnly = req.query.mine === '1' || req.query.mine === 'true';
  const vehicleMake = req.query.make ? String(req.query.make).trim() : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  let sql = `
    SELECT t.*,
           u.display_name AS driver_name,
           u.username AS username,
           v.make AS vehicle_make,
           v.model AS vehicle_model,
           v.year AS vehicle_year,
           v.trim AS vehicle_trim,
           v.suspension_type AS suspension_type,
           v.suspension_damping_factor AS suspension_damping_factor
    FROM trips t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    WHERE 1=1
  `;
  const params = [];

  if (mineOnly) {
    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Sign in to view your personal trip history.' });
    }
    sql += ' AND t.user_id = ?';
    params.push(req.user.userId);
  } else if (req.user && req.user.userId) {
    sql += ' AND (t.is_public = 1 OR t.user_id = ?)';
    params.push(req.user.userId);
  } else {
    sql += ' AND t.is_public = 1';
  }

  if (vehicleMake) {
    sql += ' AND lower(v.make) = lower(?)';
    params.push(vehicleMake);
  }

  sql += ' ORDER BY t.id DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  return res.json({
    trips: rows.map((r) => formatTripRow(r, false))
  });
});

/**
 * GET /api/trips/:id
 * Fetch full trip telemetry & detected hazards
 */
router.get('/:id', optionalAuth, (req, res) => {
  const db = getDb();
  const tripId = Number(req.params.id);

  const row = db.prepare(`
    SELECT t.*,
           u.display_name AS driver_name,
           u.username AS username,
           v.make AS vehicle_make,
           v.model AS vehicle_model,
           v.year AS vehicle_year,
           v.trim AS vehicle_trim,
           v.suspension_type AS suspension_type,
           v.suspension_damping_factor AS suspension_damping_factor
    FROM trips t
    LEFT JOIN users u ON u.id = t.user_id
    LEFT JOIN vehicles v ON v.id = t.vehicle_id
    WHERE t.id = ?
  `).get(tripId);

  if (!row) {
    return res.status(404).json({ error: 'Trip not found.' });
  }
  if (!row.is_public && (!req.user || req.user.userId !== row.user_id)) {
    return res.status(403).json({ error: 'This trip is private.' });
  }

  const hazards = db.prepare('SELECT * FROM hazards WHERE trip_id = ? ORDER BY peak_g DESC').all(tripId);
  return res.json({
    trip: formatTripRow(row, true),
    hazards
  });
});

/**
 * GET /api/trips/:id/export
 * Export trip telemetry as JSON, CSV, or GPX
 */
router.get('/:id/export', optionalAuth, (req, res) => {
  const db = getDb();
  const tripId = Number(req.params.id);
  const format = String(req.query.format || 'json').toLowerCase();

  const row = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId);
  if (!row) {
    return res.status(404).json({ error: 'Trip not found.' });
  }

  let telemetry = [];
  try {
    telemetry = row.telemetry_summary_json ? JSON.parse(row.telemetry_summary_json) : [];
  } catch {
    telemetry = [];
  }

  if (format === 'csv') {
    const header = 'timestamp_ms,lat,lng,g_lon,g_lat,g_vert,g_total,speed_mph,fsd_active\n';
    const lines = telemetry.map((p) =>
      [
        p.timestampMs || 0,
        p.lat ?? '',
        p.lng ?? '',
        p.gLon ?? 0,
        p.gLat ?? 0,
        p.gVert ?? 0,
        p.gTotal ?? 0,
        p.speedMph ?? 0,
        p.fsdActive ? 1 : 0
      ].join(',')
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="smoothroute-trip-${tripId}.csv"`);
    return res.send(header + lines.join('\n'));
  }

  if (format === 'gpx') {
    const trkpts = telemetry
      .filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number')
      .map(
        (p) =>
          `      <trkpt lat="${p.lat}" lon="${p.lng}"><time>${new Date(p.timestampMs || Date.now()).toISOString()}</time><extensions><gVert>${p.gVert}</gVert><gLon>${p.gLon}</gLon><gLat>${p.gLat}</gLat><gTotal>${p.gTotal}</gTotal></extensions></trkpt>`
      )
      .join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="SmoothRoute G-Force Tracker">
  <trk>
    <name>${String(row.title).replace(/[<>&]/g, '')}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
    res.setHeader('Content-Type', 'application/gpx+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="smoothroute-trip-${tripId}.gpx"`);
    return res.send(gpx);
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="smoothroute-trip-${tripId}.json"`);
  return res.json({
    trip: formatTripRow(row, true)
  });
});

/**
 * POST /api/trips
 * Save a recorded phone G-force trip, compute biomechanical body wear & FSD smoothness,
 * auto-detect road hazards, and optionally publish as a public route.
 */
router.post('/', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const userId = req.user.userId;
    const {
      vehicleId,
      publicRouteId = null,
      title,
      originName = 'Start Point',
      destinationName = 'Destination',
      corridorGroup = 'user-contributed',
      driveMode = 'FSD Supervised',
      phoneMountType = 'MagSafe Dash Mount',
      isPublic = true,
      publishAsRoute = false,
      autoPublishHazards = true,
      calibration = null,
      samples = [],
      notes = ''
    } = req.body || {};

    if (!Array.isArray(samples) || samples.length < 2) {
      return res.status(400).json({
        error: 'At least 2 G-force telemetry samples are required to record a trip.'
      });
    }

    // Resolve user's vehicle for suspension damping calibration
    let vehicle = null;
    if (vehicleId) {
      vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(Number(vehicleId), userId);
    }
    if (!vehicle) {
      vehicle = db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY is_primary DESC, id ASC LIMIT 1').get(userId);
    }

    const vehicleProfile = vehicle
      ? {
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          suspensionType: vehicle.suspension_type,
          wheelDiameterInches: vehicle.wheel_diameter_inches,
          tireSidewallRatio: vehicle.tire_sidewall_ratio,
          suspensionDampingFactor: vehicle.suspension_damping_factor,
          lateralRollFactor: vehicle.lateral_roll_factor,
          seatIsolationFactor: vehicle.seat_isolation_factor
        }
      : { suspensionDampingFactor: 1.0, lateralRollFactor: 1.0, seatIsolationFactor: 0.95 };

    // Transform raw phone samples (ax, ay, az) if gVert/gLon/gLat not already computed
    const processedSamples = samples.map((s, idx) => {
      if (typeof s.gVert === 'number' && typeof s.gLon === 'number' && typeof s.gLat === 'number') {
        const gTotal = typeof s.gTotal === 'number' ? s.gTotal : Math.hypot(s.gLon, s.gLat, s.gVert);
        return {
          timestampMs: s.timestampMs || Date.now() + idx * 100,
          lat: typeof s.lat === 'number' ? Number(s.lat.toFixed(6)) : undefined,
          lng: typeof s.lng === 'number' ? Number(s.lng.toFixed(6)) : undefined,
          gLon: Number(s.gLon.toFixed(4)),
          gLat: Number(s.gLat.toFixed(4)),
          gVert: Number(s.gVert.toFixed(4)),
          gTotal: Number(gTotal.toFixed(4)),
          speedMph: Number((s.speedMph ?? 45).toFixed(1)),
          fsdActive: s.fsdActive !== undefined ? Boolean(s.fsdActive) : driveMode.includes('FSD')
        };
      }
      const transformed = transformPhoneToVehicleG(s, calibration);
      return {
        timestampMs: s.timestampMs || Date.now() + idx * 100,
        lat: typeof s.lat === 'number' ? Number(s.lat.toFixed(6)) : undefined,
        lng: typeof s.lng === 'number' ? Number(s.lng.toFixed(6)) : undefined,
        ...transformed,
        speedMph: Number((s.speedMph ?? 45).toFixed(1)),
        fsdActive: s.fsdActive !== undefined ? Boolean(s.fsdActive) : driveMode.includes('FSD')
      };
    });

    // Run Physics & Biomechanics Engine
    const analysis = analyzeTripBiomechanics(processedSamples, vehicleProfile);
    const detectedHazards = detectGForceHazards(processedSamples, vehicleProfile);

    // Downsample stored telemetry trace to at most 300 points for fast replay
    const maxStoredPoints = 300;
    const stride = Math.max(1, Math.floor(processedSamples.length / maxStoredPoints));
    const summaryTrace = processedSamples.filter((_, i) => i % stride === 0 || i === processedSamples.length - 1);

    const tripTitle =
      (title && String(title).trim()) ||
      `${originName} to ${destinationName} (${driveMode})`;

    let targetRouteId = publicRouteId ? Number(publicRouteId) : null;

    // Optionally publish or update a Public Route from this recorded trip
    if (publishAsRoute) {
      const gpsPoints = summaryTrace.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
      if (gpsPoints.length >= 2) {
        const firstPt = gpsPoints[0];
        const lastPt = gpsPoints[gpsPoints.length - 1];
        const routeWaypoints = gpsPoints.map((p) => [p.lat, p.lng, Math.abs(p.gVert), p.speedMph || 45]);
        const slug = `route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const estMin = Math.max(2, Number((analysis.durationSec / 60).toFixed(1)));
        const distMi = Math.max(0.2, analysis.distanceMiles || Number(((estMin / 60) * 42).toFixed(1)));

        const routeInsert = db.prepare(`
          INSERT INTO public_routes (
            slug, corridor_group, name, origin_name, destination_name,
            origin_lat, origin_lng, dest_lat, dest_lng,
            distance_miles, estimated_minutes, highway_summary,
            smoothness_score, fsd_comfort_score, fsd_grade,
            body_wear_score, body_wear_grade,
            avg_vertical_g, peak_vertical_g, peak_lateral_g, peak_longitudinal_g,
            normalized_road_roughness_g, avg_jerk_g_per_sec, vdv_score, spine_shock_count,
            fsd_notes, surface_type, waypoints_json, sample_trips_count, upvotes, created_by_user_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
        `).run(
          slug,
          corridorGroup || 'user-contributed',
          tripTitle,
          originName,
          destinationName,
          firstPt.lat,
          firstPt.lng,
          lastPt.lat,
          lastPt.lng,
          distMi,
          estMin,
          `Recorded via ${vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : 'Phone Telemetry'} (${driveMode})`,
          analysis.smoothnessScore,
          analysis.fsdComfortScore,
          analysis.fsdGrade,
          analysis.bodyWearScore,
          analysis.bodyWearGrade,
          analysis.rmsGVert,
          analysis.peakGVert,
          analysis.peakGLat,
          analysis.peakGLon,
          analysis.normalizedRoadRoughnessG,
          analysis.avgJerkGPerSec,
          analysis.vibrationDoseValueVdv,
          analysis.spineMicroShocksCount,
          notes || analysis.fsdRecommendation,
          analysis.smoothnessScore >= 85 ? 'Smooth Asphalt' : analysis.smoothnessScore >= 65 ? 'Mixed Pavement' : 'Rough Surface / High G',
          JSON.stringify(routeWaypoints),
          userId
        );

        targetRouteId = Number(routeInsert.lastInsertRowid);
      }
    } else if (targetRouteId) {
      // Increment sample_trips_count on existing route
      db.prepare('UPDATE public_routes SET sample_trips_count = sample_trips_count + 1 WHERE id = ?').run(targetRouteId);
    }

    const insertTripResult = db.prepare(`
      INSERT INTO trips (
        user_id, vehicle_id, public_route_id, title, origin_name, destination_name,
        drive_mode, phone_mount_type, status, is_public,
        sample_count, duration_sec, distance_miles,
        peak_g_lon, peak_g_lat, peak_g_vert, peak_g_total,
        avg_dynamic_g, rms_g_vert, normalized_road_roughness_g,
        peak_jerk, avg_jerk, iso_weighted_rms, vdv,
        spine_micro_shocks, severe_shocks, hard_brakes,
        body_wear_score, body_wear_grade,
        smoothness_score, fsd_comfort_score, fsd_grade, fsd_recommendation,
        telemetry_summary_json, notes, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      userId,
      vehicle ? vehicle.id : null,
      targetRouteId,
      tripTitle,
      originName,
      destinationName,
      driveMode,
      phoneMountType,
      isPublic ? 1 : 0,
      analysis.sampleCount,
      analysis.durationSec,
      analysis.distanceMiles,
      analysis.peakGLon,
      analysis.peakGLat,
      analysis.peakGVert,
      analysis.peakGTotal,
      analysis.avgDynamicG,
      analysis.rmsGVert,
      analysis.normalizedRoadRoughnessG,
      analysis.peakJerkGPerSec,
      analysis.avgJerkGPerSec,
      analysis.isoWeightedRmsMps2,
      analysis.vibrationDoseValueVdv,
      analysis.spineMicroShocksCount,
      analysis.severeShockCount,
      analysis.hardBrakeCount,
      analysis.bodyWearScore,
      analysis.bodyWearGrade,
      analysis.smoothnessScore,
      analysis.fsdComfortScore,
      analysis.fsdGrade,
      analysis.fsdRecommendation,
      JSON.stringify(summaryTrace),
      notes
    );

    const tripId = Number(insertTripResult.lastInsertRowid);

    // Save detected G-force hazards
    const savedHazards = [];
    if (autoPublishHazards && detectedHazards.length > 0) {
      const insertHaz = db.prepare(`
        INSERT INTO hazards (
          trip_id, route_id, reported_by_user_id, vehicle_label,
          type, severity, label, description, road_name,
          lat, lng, peak_g, vertical_g, lateral_g, longitudinal_g,
          normalized_severity_g, speed_mph, confirmations
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `);

      const vehLabel = vehicle
        ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`
        : 'Driver Telemetry';

      for (const h of detectedHazards.slice(0, 12)) {
        const resHaz = insertHaz.run(
          tripId,
          targetRouteId,
          userId,
          vehLabel,
          h.type,
          h.severity,
          h.label,
          h.description,
          `${originName} -> ${destinationName}`,
          h.lat,
          h.lng,
          h.peakG,
          h.verticalG,
          h.lateralG,
          h.longitudinalG,
          h.normalizedSeverityG,
          h.speedMph
        );
        savedHazards.push({ id: Number(resHaz.lastInsertRowid), ...h });
      }
    }

    const createdRow = db.prepare(`
      SELECT t.*,
             u.display_name AS driver_name,
             u.username AS username,
             v.make AS vehicle_make,
             v.model AS vehicle_model,
             v.year AS vehicle_year,
             v.trim AS vehicle_trim,
             v.suspension_type AS suspension_type,
             v.suspension_damping_factor AS suspension_damping_factor
      FROM trips t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN vehicles v ON v.id = t.vehicle_id
      WHERE t.id = ?
    `).get(tripId);

    return res.status(201).json({
      trip: formatTripRow(createdRow, true),
      analysis,
      detectedHazards: savedHazards,
      publishedRouteId: targetRouteId
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to save trip telemetry: ${err.message}` });
  }
});

/**
 * DELETE /api/trips/:id
 */
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const tripId = Number(req.params.id);
  const existing = db.prepare('SELECT id, user_id FROM trips WHERE id = ?').get(tripId);
  if (!existing) {
    return res.status(404).json({ error: 'Trip not found.' });
  }
  if (existing.user_id !== req.user.userId) {
    return res.status(403).json({ error: 'You can only delete your own recorded trips.' });
  }

  db.prepare('DELETE FROM trips WHERE id = ?').run(tripId);
  return res.json({ success: true });
});

module.exports = router;
