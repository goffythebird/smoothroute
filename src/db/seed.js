/**
 * SmoothRoute — Database Seeder
 * Populates initial community routes, multi-corridor FSD comparisons, G-force hazards,
 * and benchmark trips so the public map and route planner are immediately rich & actionable.
 */

require('dotenv').config();
const { getDb } = require('./database');
const { hashPassword } = require('../utils/auth');

function generateTelemetryTrace(waypoints, baseVertG, peakVertG, durationSec = 180) {
  const trace = [];
  const count = waypoints.length;
  const now = Date.now() - 3600 * 1000;

  for (let i = 0; i < count; i++) {
    const wp = waypoints[i];
    const progress = i / Math.max(1, count - 1);
    const tMs = now + Math.round(progress * durationSec * 1000);
    const gVert = Number((wp[2] !== undefined ? wp[2] : baseVertG * Math.sin(i * 1.3)).toFixed(3));
    const gLon = Number((0.06 * Math.cos(i * 0.7) - (Math.abs(gVert) > 0.45 ? 0.28 : 0)).toFixed(3));
    const gLat = Number((0.09 * Math.sin(i * 0.5)).toFixed(3));
    const gTotal = Number(Math.hypot(gLon, gLat, gVert).toFixed(3));

    trace.push({
      timestampMs: tMs,
      lat: wp[0],
      lng: wp[1],
      gLon,
      gLat,
      gVert,
      gTotal,
      speedMph: wp[3] || 58,
      fsdActive: true
    });
  }
  return trace;
}

function ensureSeeded(db = getDb()) {
  const existingRoutes = db.prepare('SELECT COUNT(*) as cnt FROM public_routes').get();
  if (existingRoutes && existingRoutes.cnt > 0) {
    return { seeded: false, message: 'Database already seeded' };
  }

  // 1. Seed community contributors
  const insertUser = db.prepare(`
    INSERT INTO users (username, email, password_hash, display_name, driver_mode_preference, fsd_driver, body_sensitivity, calibration_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const defaultPassHash = hashPassword('SmoothFSD2026!');
  const defaultCal = JSON.stringify({
    gravityBaseline: { gx: 0.0, gy: 9.215, gz: 3.354, magnitude: 9.8066 },
    mountAngles: { pitchDeg: 70.0, rollDeg: 0.0 }
  });

  const u1 = insertUser.run(
    'tesla_fsd_pilot',
    'pilot@smoothroute.open',
    defaultPassHash,
    'Alex Rivera (FSD v13 Pilot)',
    'fsd_smooth',
    1,
    'sensitive_spine',
    defaultCal
  ).lastInsertRowid;

  const u2 = insertUser.run(
    'spine_saver_ev',
    'elena@smoothroute.open',
    defaultPassHash,
    'Dr. Elena Vance (Biomechanics)',
    'low_body_wear',
    1,
    'sensitive_spine',
    defaultCal
  ).lastInsertRowid;

  const u3 = insertUser.run(
    'bay_performance_m3p',
    'marcus@smoothroute.open',
    defaultPassHash,
    'Marcus Chen (Model 3 Perf)',
    'fsd_smooth',
    1,
    'normal',
    defaultCal
  ).lastInsertRowid;

  // 2. Seed Vehicles for Community Users
  const insertVehicle = db.prepare(`
    INSERT INTO vehicles (
      user_id, template_id, nickname, make, model, year, trim, category,
      suspension_type, suspension_label, wheel_diameter_inches, tire_sidewall_ratio,
      curb_weight_lbs, supports_fsd, fsd_hardware, suspension_damping_factor,
      lateral_roll_factor, seat_isolation_factor, is_primary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const v1 = insertVehicle.run(
    u1,
    'tesla-model-y-lr',
    'Starship Y (FSD Daily)',
    'Tesla',
    'Model Y',
    2025,
    'Long Range AWD (19" Gemini)',
    'EV Crossover SUV',
    'coil_comfort',
    'Comfort Retuned Coil Suspension',
    19,
    45,
    4363,
    1,
    'HW4 / AI4',
    1.06,
    1.04,
    0.95,
    1
  ).lastInsertRowid;

  const v2 = insertVehicle.run(
    u2,
    'tesla-model-s-lr',
    'Cloud Nine Air S',
    'Tesla',
    'Model S',
    2025,
    'Dual Motor Air Suspension (19" Tempest)',
    'EV Flagship Sedan',
    'air_adaptive',
    'Predictive Adaptive Air Suspension',
    19,
    45,
    4560,
    1,
    'HW4 / AI4',
    0.78,
    0.84,
    0.86,
    1
  ).lastInsertRowid;

  const v3 = insertVehicle.run(
    u3,
    'tesla-model-3-perf',
    'Track & Commute M3P',
    'Tesla',
    'Model 3 Performance',
    2025,
    'Performance AWD (20" Warp)',
    'EV Sport Sedan',
    'adaptive_sport',
    'Adaptive Sport Coilovers (20" Low-Profile)',
    20,
    30,
    4054,
    1,
    'HW4 / AI4',
    1.24,
    0.78,
    0.98,
    1
  ).lastInsertRowid;

  const v4 = insertVehicle.run(
    u1,
    'tesla-cybertruck-awd',
    'CyberBeast Smooth Air',
    'Tesla',
    'Cybertruck',
    2025,
    'All-Wheel Drive (35" All-Terrain)',
    'EV Pickup Truck',
    'air_adaptive',
    '12" Travel Adaptive Air + Rear Steer',
    20,
    65,
    6603,
    1,
    'HW4 / AI4',
    0.85,
    0.92,
    0.90,
    0
  ).lastInsertRowid;

  // 3. Seed Public Multi-Route Corridors
  const insertRoute = db.prepare(`
    INSERT INTO public_routes (
      slug, corridor_group, name, origin_name, destination_name,
      origin_lat, origin_lng, dest_lat, dest_lng,
      distance_miles, estimated_minutes, highway_summary,
      smoothness_score, fsd_comfort_score, fsd_grade,
      body_wear_score, body_wear_grade,
      avg_vertical_g, peak_vertical_g, peak_lateral_g, peak_longitudinal_g,
      normalized_road_roughness_g, avg_jerk_g_per_sec, vdv_score, spine_shock_count,
      fsd_notes, surface_type, waypoints_json, sample_trips_count, upvotes, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Corridor 1: San Francisco to Palo Alto
  const i280Waypoints = [
    [37.7320, -122.4460, 0.04, 62],
    [37.6850, -122.4620, 0.05, 65],
    [37.6240, -122.4320, 0.04, 68],
    [37.5710, -122.3780, 0.06, 67],
    [37.5180, -122.3360, 0.05, 66],
    [37.4620, -122.2750, 0.04, 65],
    [37.4220, -122.2180, 0.05, 60],
    [37.4280, -122.1680, 0.06, 45]
  ];

  const r1 = insertRoute.run(
    'i280-junipero-serra-fsd-smooth',
    'sf-palo-alto',
    'I-280 S — Junipero Serra FSD Smooth Ribbon',
    'San Francisco',
    'Palo Alto / Stanford',
    37.7320, -122.4460,
    37.4280, -122.1680,
    34.2, 37.0,
    'I-280 S via Crystal Springs Reservoir & Page Mill Rd',
    96, 97, 'S+ Ultra Smooth',
    9, 'Minimal Wear',
    0.044, 0.18, 0.16, 0.14,
    0.042, 0.22, 1.85, 0,
    'Gold-standard Tesla FSD highway. Freshly repaved continuous asphalt, wide lane markings, zero sunken bridge joints, and 86% lower spine vibration than US-101.',
    'Continuous Polymer-Modified Asphalt',
    JSON.stringify(i280Waypoints),
    142, 89, u1
  ).lastInsertRowid;

  const us101Waypoints = [
    [37.7320, -122.4050, 0.14, 58],
    [37.6690, -122.3910, 0.42, 55],
    [37.6150, -122.3890, 0.68, 60],
    [37.5680, -122.3240, 0.54, 52],
    [37.5190, -122.2760, 0.39, 48],
    [37.4820, -122.2260, 0.74, 56],
    [37.4510, -122.1640, 0.48, 50],
    [37.4280, -122.1680, 0.18, 35]
  ];

  const r2 = insertRoute.run(
    'us101-bayshore-rough-corridor',
    'sf-palo-alto',
    'US-101 S — Bayshore Freeway (High G-Shock Warning)',
    'San Francisco',
    'Palo Alto / Stanford',
    37.7320, -122.4050,
    37.4280, -122.1680,
    31.8, 35.0,
    'US-101 S via SFO Airport & Redwood City Overpasses',
    54, 51, 'D Rough / High Wear',
    68, 'High Body Wear',
    0.175, 0.74, 0.32, 0.49,
    0.165, 1.48, 9.60, 9,
    'WARNING: Despite being 2 mins shorter on paper, heavy freight rutting and sunken concrete expansion joints near SFO & Marsh Rd cause up to 0.74G vertical shocks and frequent FSD braking for short weave merges.',
    'Rutted Concrete + Raised Overpass Joints',
    JSON.stringify(us101Waypoints),
    98, 12, u3
  ).lastInsertRowid;

  const elCaminoWaypoints = [
    [37.7320, -122.4460, 0.11, 35],
    [37.6740, -122.4560, 0.24, 38],
    [37.6020, -122.3910, 0.36, 35],
    [37.5540, -122.3280, 0.49, 32],
    [37.4980, -122.2560, 0.28, 35],
    [37.4480, -122.1780, 0.22, 30],
    [37.4280, -122.1680, 0.14, 28]
  ];

  const r3 = insertRoute.run(
    'ca82-el-camino-surface-street',
    'sf-palo-alto',
    'CA-82 S — El Camino Real Urban Arterial',
    'San Francisco',
    'Palo Alto / Stanford',
    37.7320, -122.4460,
    37.4280, -122.1680,
    32.5, 51.0,
    'CA-82 S El Camino Real (Surface Signal Corridor)',
    67, 64, 'C Moderate Roughness',
    46, 'Moderate Body Wear',
    0.122, 0.51, 0.27, 0.41,
    0.115, 0.92, 6.10, 4,
    '45+ traffic lights induce repetitive longitudinal braking/acceleration cycles; sunken utility manhole covers in right lane.',
    'Urban Asphalt Patchwork',
    JSON.stringify(elCaminoWaypoints),
    44, 21, u2
  ).lastInsertRowid;

  // Corridor 2: Cupertino to Mountain View / Palo Alto
  const foothillWaypoints = [
    [37.3349, -122.0090, 0.05, 55],
    [37.3420, -122.0540, 0.04, 62],
    [37.3610, -122.0980, 0.06, 50],
    [37.3840, -122.1260, 0.05, 48],
    [37.4050, -122.1440, 0.06, 45],
    [37.4280, -122.1430, 0.04, 40]
  ];

  const r4 = insertRoute.run(
    'i280-foothill-expressway-glide',
    'silicon-valley-cross',
    'I-280 N to Foothill Expy — FSD Glide Corridor',
    'Cupertino (Apple Park)',
    'Palo Alto / Mountain View',
    37.3349, -122.0090,
    37.4280, -122.1430,
    11.4, 16.0,
    'I-280 N -> Foothill Expressway (Low-Vibration Corridor)',
    93, 94, 'S+ Ultra Smooth',
    12, 'Minimal Wear',
    0.051, 0.21, 0.17, 0.18,
    0.048, 0.26, 2.15, 0,
    'Avoids CA-85 concrete slab washboard resonance completely. Smooth resurfaced asphalt and synchronized expressway signals.',
    'Resurfaced Smooth Asphalt',
    JSON.stringify(foothillWaypoints),
    87, 64, u2
  ).lastInsertRowid;

  const ca85Waypoints = [
    [37.3349, -122.0090, 0.12, 55],
    [37.3410, -122.0380, 0.34, 62],
    [37.3650, -122.0620, 0.58, 64],
    [37.3890, -122.0750, 0.62, 60],
    [37.4110, -122.0840, 0.44, 55],
    [37.4280, -122.1430, 0.19, 42]
  ];

  const r5 = insertRoute.run(
    'ca85-concrete-harmonic-bounce',
    'silicon-valley-cross',
    'CA-85 N — Concrete Slab Resonance Route',
    'Cupertino (Apple Park)',
    'Palo Alto / Mountain View',
    37.3349, -122.0090,
    37.4280, -122.1430,
    10.2, 14.5,
    'CA-85 N to US-101 N (Grooved Concrete Slabs)',
    61, 63, 'C Moderate Roughness',
    54, 'High Body Wear',
    0.148, 0.62, 0.29, 0.36,
    0.140, 1.12, 7.80, 5,
    'Spaced concrete slab joints excite 4.8 Hz vertical chassis pitch in Model Y and Model 3 at 65 mph, causing cumulative lower-back fatigue.',
    'Segmented Grooved Concrete Slabs',
    JSON.stringify(ca85Waypoints),
    63, 15, u1
  ).lastInsertRowid;

  // Corridor 3: Austin Downtown to Giga Texas
  const sh130Waypoints = [
    [30.2672, -97.7431, 0.06, 45],
    [30.2540, -97.7020, 0.05, 60],
    [30.2410, -97.6610, 0.04, 70],
    [30.2320, -97.6280, 0.05, 65],
    [30.2235, -97.6171, 0.04, 40]
  ];

  const r6 = insertRoute.run(
    'austin-sh71-sh130-giga-smooth',
    'austin-gigafactory',
    'SH-71 E to SH-130 Toll — Giga Texas FSD Express',
    'Austin Downtown',
    'Giga Texas (Tesla HQ)',
    30.2672, -97.7431,
    30.2235, -97.6171,
    14.8, 18.0,
    'E Cesar Chavez -> SH-71 E -> SH-130 N Smooth Tollway',
    95, 96, 'S+ Ultra Smooth',
    10, 'Minimal Wear',
    0.046, 0.19, 0.15, 0.15,
    0.044, 0.21, 1.92, 0,
    'Engineered high-speed concrete & smooth tollway approaches to Giga Texas; zero construction plates.',
    'Precision Highway Pavement',
    JSON.stringify(sh130Waypoints),
    112, 78, u1
  ).lastInsertRowid;

  const us183Waypoints = [
    [30.2672, -97.7431, 0.18, 42],
    [30.2610, -97.6980, 0.56, 48],
    [30.2520, -97.6680, 0.86, 52],
    [30.2380, -97.6410, 0.64, 45],
    [30.2235, -97.6171, 0.31, 35]
  ];

  const r7 = insertRoute.run(
    'austin-us183-rough-construction',
    'austin-gigafactory',
    'US-183 S — Bridge Deck & Construction Plate Route',
    'Austin Downtown',
    'Giga Texas (Tesla HQ)',
    30.2672, -97.7431,
    30.2235, -97.6171,
    12.1, 17.0,
    'E 7th St -> US-183 S -> FM 969',
    48, 44, 'F Severe G Hazards',
    77, 'Severe Orthopedic Stress',
    0.210, 0.86, 0.41, 0.54,
    0.198, 1.85, 11.40, 11,
    'SEVERE G WARNING: Recessed steel trench plates and abrupt bridge abutment lips on US-183 S produce 0.86G vertical impacts and sharp FSD lane-shift corrections.',
    'Construction Patchwork & Steel Plates',
    JSON.stringify(us183Waypoints),
    59, 9, u3
  ).lastInsertRowid;

  // 4. Seed Sample Trips with Telemetry Traces
  const insertTrip = db.prepare(`
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
      telemetry_summary_json, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const trace1 = generateTelemetryTrace(i280Waypoints, 0.044, 0.18, 2220);
  const t1 = insertTrip.run(
    u1, v1, r1,
    'Morning FSD v13 Glide on I-280 South',
    'San Francisco', 'Palo Alto / Stanford',
    'FSD Supervised', 'MagSafe Center Screen Mount',
    2220, 2220, 34.2,
    0.14, 0.16, 0.18, 0.24,
    0.052, 0.046, 0.043,
    0.65, 0.22, 0.58, 1.85,
    0, 0, 0,
    9, 'Minimal Wear',
    96, 97, 'S+ Ultra Smooth',
    'Top-tier FSD corridor: ultra-low vertical G, smooth longitudinal control, minimal body fatigue.',
    JSON.stringify(trace1),
    'Zero interventions on FSD v13.2. Cabin stayed whisper quiet and vertical G never exceeded 0.18G.'
  ).lastInsertRowid;

  const trace2 = generateTelemetryTrace(us101Waypoints, 0.175, 0.74, 2100);
  const t2 = insertTrip.run(
    u3, v3, r2,
    'US-101 South Commute in Model 3 Performance (20" Wheels)',
    'San Francisco', 'Palo Alto / Stanford',
    'FSD Supervised', 'MagSafe Dash Mount',
    2100, 2100, 31.8,
    0.49, 0.32, 0.74, 0.82,
    0.195, 0.188, 0.152,
    3.85, 1.48, 2.42, 9.60,
    9, 3, 2,
    68, 'High Body Wear',
    54, 51, 'D Rough / High Wear',
    'Significant vertical shock & cabin jerk detected. High body wear on stiffer suspensions.',
    JSON.stringify(trace2),
    'Brutal expansion joints near SFO & Whipple Ave on 20" Warp wheels. Switched back to I-280 permanently.'
  ).lastInsertRowid;

  const trace3 = generateTelemetryTrace(foothillWaypoints, 0.051, 0.21, 960);
  insertTrip.run(
    u2, v2, r4,
    'Model S Air Suspension Biomechanical Baseline — Foothill Expy',
    'Cupertino (Apple Park)', 'Palo Alto / Mountain View',
    'FSD Supervised', 'Wireless Charging Pad (Calibrated 62°)',
    960, 960, 11.4,
    0.16, 0.15, 0.17, 0.21,
    0.045, 0.039, 0.050,
    0.58, 0.20, 0.49, 1.62,
    0, 0, 0,
    8, 'Minimal Wear',
    96, 97, 'S+ Ultra Smooth',
    'Top-tier FSD corridor: ultra-low vertical G, smooth longitudinal control, minimal body fatigue.',
    JSON.stringify(trace3),
    'Adaptive Air Suspension in Comfort mode reduced vertical VDV dose by 64% compared to CA-85.'
  );

  // 5. Seed Community G-Force Road Hazards
  const insertHazard = db.prepare(`
    INSERT INTO hazards (
      trip_id, route_id, reported_by_user_id, vehicle_label,
      type, severity, label, description, road_name,
      lat, lng, peak_g, vertical_g, lateral_g, longitudinal_g,
      normalized_severity_g, speed_mph, confirmations
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertHazard.run(
    t2, r2, u3, '2025 Tesla Model 3 Performance (20")',
    'pothole_shock', 'severe',
    'Severe Sunken Overpass Joint (0.74G Vertical)',
    'Deep asphalt settlement at bridge abutment on US-101 S lane 2. Causes sharp 0.74G spinal compression spike at 60 mph.',
    'US-101 S @ Marsh Rd Overpass',
    37.4820, -122.2260,
    0.82, 0.74, 0.14, -0.22, 0.66, 58, 34
  );

  insertHazard.run(
    t2, r2, u1, '2025 Tesla Model Y Long Range',
    'pothole_shock', 'high',
    'Clustered Freight Ruts & Crater (0.68G)',
    'Heavy truck lane rutting and broken concrete slab near Millbrae interchange.',
    'US-101 S near SFO / Millbrae',
    37.6150, -122.3890,
    0.73, 0.68, 0.18, -0.19, 0.64, 60, 27
  );

  insertHazard.run(
    t2, r2, u1, '2025 Tesla Model Y Long Range',
    'fsd_braking_zone', 'high',
    'FSD Hard Deceleration / Short Weave Merge (-0.49G)',
    'Short auxiliary merge lane causes FSD and human traffic to brake abruptly (-0.49G longitudinal pitch).',
    'US-101 S @ Hillsdale Blvd',
    37.5680, -122.3240,
    0.54, 0.21, 0.12, -0.49, 0.51, 52, 19
  );

  insertHazard.run(
    null, r5, u2, '2025 Tesla Model S Air',
    'expansion_joint', 'moderate',
    'Concrete Slab Harmonic Bounce (4.8 Hz WBV)',
    'Uniformly spaced concrete expansion joints induce continuous vertical oscillation and lumbar fatigue.',
    'CA-85 N @ Fremont Ave',
    37.3650, -122.0620,
    0.58, 0.54, 0.11, -0.08, 0.58, 63, 22
  );

  insertHazard.run(
    null, r3, u2, '2025 Tesla Model S Air',
    'pothole_shock', 'high',
    'Recessed Utility Trench & Manhole Cover (0.51G)',
    'Sunken iron manhole cover directly in the right wheel track.',
    'El Camino Real (CA-82) @ Burlingame',
    37.5540, -122.3280,
    0.55, 0.51, 0.09, -0.15, 0.52, 34, 15
  );

  insertHazard.run(
    null, r7, u3, '2025 Tesla Model 3 Performance',
    'pothole_shock', 'severe',
    'Unbeveled Steel Construction Plate (0.86G)',
    'Raised steel trench plate across lanes 1-2 causes violent vertical tire impact; high rim & spine hazard.',
    'US-183 S near Bolm Rd (Austin)',
    30.2520, -97.6680,
    0.91, 0.86, 0.19, -0.25, 0.74, 52, 41
  );

  return { seeded: true, message: 'Database seeded with community routes, vehicles, trips, and G-force hazards.' };
}

if (require.main === module) {
  const result = ensureSeeded();
  console.log(result.message);
}

module.exports = {
  ensureSeeded,
  generateTelemetryTrace
};
