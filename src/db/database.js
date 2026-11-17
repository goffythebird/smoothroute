/**
 * SmoothRoute — SQLite Database Connection & Schema Initialization
 * Uses Node's built-in node:sqlite DatabaseSync with WAL journaling and foreign keys.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

let dbInstance = null;
let currentDbPath = null;

function getDbPath() {
  const configured = process.env.DB_PATH || './data/smoothroute.db';
  return path.isAbsolute(configured)
    ? configured
    : path.resolve(__dirname, '../../', configured);
}

function getDb() {
  const targetPath = getDbPath();
  if (dbInstance && currentDbPath === targetPath) {
    return dbInstance;
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = new DatabaseSync(targetPath);
  currentDbPath = targetPath;

  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  dbInstance.exec('PRAGMA synchronous = NORMAL;');

  initSchema(dbInstance);
  return dbInstance;
}

function closeDb() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch {
      // ignore close errors
    }
    dbInstance = null;
    currentDbPath = null;
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      driver_mode_preference TEXT DEFAULT 'fsd_smooth',
      fsd_driver INTEGER DEFAULT 1,
      body_sensitivity TEXT DEFAULT 'normal',
      calibration_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      template_id TEXT,
      nickname TEXT,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER NOT NULL,
      trim TEXT,
      category TEXT DEFAULT 'EV Sedan',
      suspension_type TEXT NOT NULL DEFAULT 'coil_standard',
      suspension_label TEXT,
      wheel_diameter_inches REAL DEFAULT 19,
      tire_sidewall_ratio REAL DEFAULT 45,
      curb_weight_lbs REAL DEFAULT 4200,
      supports_fsd INTEGER DEFAULT 1,
      fsd_hardware TEXT DEFAULT 'HW4 / AI4',
      suspension_damping_factor REAL DEFAULT 1.0,
      lateral_roll_factor REAL DEFAULT 1.0,
      seat_isolation_factor REAL DEFAULT 0.95,
      is_primary INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS public_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      corridor_group TEXT NOT NULL,
      name TEXT NOT NULL,
      origin_name TEXT NOT NULL,
      destination_name TEXT NOT NULL,
      origin_lat REAL NOT NULL,
      origin_lng REAL NOT NULL,
      dest_lat REAL NOT NULL,
      dest_lng REAL NOT NULL,
      distance_miles REAL NOT NULL,
      estimated_minutes REAL NOT NULL,
      highway_summary TEXT,
      smoothness_score INTEGER NOT NULL,
      fsd_comfort_score INTEGER NOT NULL,
      fsd_grade TEXT NOT NULL,
      body_wear_score INTEGER NOT NULL,
      body_wear_grade TEXT NOT NULL,
      avg_vertical_g REAL NOT NULL,
      peak_vertical_g REAL NOT NULL,
      peak_lateral_g REAL NOT NULL,
      peak_longitudinal_g REAL NOT NULL,
      normalized_road_roughness_g REAL NOT NULL,
      avg_jerk_g_per_sec REAL DEFAULT 0.4,
      vdv_score REAL DEFAULT 3.2,
      spine_shock_count INTEGER DEFAULT 1,
      fsd_notes TEXT,
      surface_type TEXT DEFAULT 'Asphalt',
      waypoints_json TEXT NOT NULL,
      sample_trips_count INTEGER DEFAULT 1,
      upvotes INTEGER DEFAULT 0,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
      public_route_id INTEGER REFERENCES public_routes(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      origin_name TEXT,
      destination_name TEXT,
      drive_mode TEXT DEFAULT 'FSD Supervised',
      phone_mount_type TEXT DEFAULT 'MagSafe Dash Mount',
      status TEXT DEFAULT 'completed',
      is_public INTEGER DEFAULT 1,
      sample_count INTEGER DEFAULT 0,
      duration_sec REAL DEFAULT 0,
      distance_miles REAL DEFAULT 0,
      peak_g_lon REAL DEFAULT 0,
      peak_g_lat REAL DEFAULT 0,
      peak_g_vert REAL DEFAULT 0,
      peak_g_total REAL DEFAULT 0,
      avg_dynamic_g REAL DEFAULT 0,
      rms_g_vert REAL DEFAULT 0,
      normalized_road_roughness_g REAL DEFAULT 0,
      peak_jerk REAL DEFAULT 0,
      avg_jerk REAL DEFAULT 0,
      iso_weighted_rms REAL DEFAULT 0,
      vdv REAL DEFAULT 0,
      spine_micro_shocks INTEGER DEFAULT 0,
      severe_shocks INTEGER DEFAULT 0,
      hard_brakes INTEGER DEFAULT 0,
      body_wear_score INTEGER DEFAULT 0,
      body_wear_grade TEXT DEFAULT 'Minimal Wear',
      smoothness_score INTEGER DEFAULT 100,
      fsd_comfort_score INTEGER DEFAULT 100,
      fsd_grade TEXT DEFAULT 'S+ Ultra Smooth',
      fsd_recommendation TEXT,
      telemetry_summary_json TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS hazards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
      route_id INTEGER REFERENCES public_routes(id) ON DELETE SET NULL,
      reported_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      vehicle_label TEXT,
      type TEXT NOT NULL,
      severity TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      road_name TEXT,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      peak_g REAL NOT NULL,
      vertical_g REAL DEFAULT 0,
      lateral_g REAL DEFAULT 0,
      longitudinal_g REAL DEFAULT 0,
      normalized_severity_g REAL DEFAULT 0,
      speed_mph REAL DEFAULT 35,
      confirmations INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_vehicles_user ON vehicles(user_id);
    CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
    CREATE INDEX IF NOT EXISTS idx_trips_public ON trips(is_public);
    CREATE INDEX IF NOT EXISTS idx_routes_corridor ON public_routes(corridor_group);
    CREATE INDEX IF NOT EXISTS idx_hazards_route ON hazards(route_id);
  `);
}

module.exports = {
  getDb,
  closeDb,
  getDbPath
};
