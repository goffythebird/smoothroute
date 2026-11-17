/**
 * SmoothRoute — Authentication & User Profile Routes
 */

const express = require('express');
const { getDb } = require('../db/database');
const { hashPassword, verifyPassword, signJwt } = require('../utils/auth');
const { requireAuth } = require('../middleware/authMiddleware');
const { VEHICLE_TEMPLATES, computeVehicleTransferFactor, calibrateMountOrientation } = require('../physics/gforceEngine');

const router = express.Router();

function formatUserRow(row, vehicles = []) {
  if (!row) return null;
  let calibration = null;
  try {
    calibration = row.calibration_json ? JSON.parse(row.calibration_json) : null;
  } catch {
    calibration = null;
  }
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    driverModePreference: row.driver_mode_preference || 'fsd_smooth',
    fsdDriver: Boolean(row.fsd_driver),
    bodySensitivity: row.body_sensitivity || 'normal',
    calibration,
    createdAt: row.created_at,
    vehicles
  };
}

function getUserVehicles(db, userId) {
  const rows = db.prepare('SELECT * FROM vehicles WHERE user_id = ? ORDER BY is_primary DESC, id ASC').all(userId);
  return rows.map((v) => ({
    id: v.id,
    userId: v.user_id,
    templateId: v.template_id,
    nickname: v.nickname,
    make: v.make,
    model: v.model,
    year: v.year,
    trim: v.trim,
    category: v.category,
    suspensionType: v.suspension_type,
    suspensionLabel: v.suspension_label,
    wheelDiameterInches: v.wheel_diameter_inches,
    tireSidewallRatio: v.tire_sidewall_ratio,
    curbWeightLbs: v.curb_weight_lbs,
    supportsFsd: Boolean(v.supports_fsd),
    fsdHardware: v.fsd_hardware,
    suspensionDampingFactor: v.suspension_damping_factor,
    lateralRollFactor: v.lateral_roll_factor,
    seatIsolationFactor: v.seat_isolation_factor,
    isPrimary: Boolean(v.is_primary),
    createdAt: v.created_at
  }));
}

/**
 * POST /api/auth/signup
 * Register a new user account and optionally set up their primary car in the garage.
 */
router.post('/signup', (req, res) => {
  try {
    const db = getDb();
    const {
      username,
      email,
      password,
      displayName,
      driverModePreference = 'fsd_smooth',
      fsdDriver = true,
      bodySensitivity = 'normal',
      vehicleTemplateId = 'tesla-model-y-lr',
      customVehicle = null
    } = req.body || {};

    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Username, email, and password are required to create an account.'
      });
    }

    const cleanUsername = String(username).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '');
    const cleanEmail = String(email).trim().toLowerCase();

    if (cleanUsername.length < 3) {
      return res.status(400).json({
        error: 'Username must be at least 3 alphanumeric characters.'
      });
    }
    if (!cleanEmail.includes('@')) {
      return res.status(400).json({
        error: 'Please provide a valid email address.'
      });
    }
    if (String(password).length < 6) {
      return res.status(400).json({
        error: 'Password must be at least 6 characters long.'
      });
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ? OR email = ?')
      .get(cleanUsername, cleanEmail);
    if (existing) {
      return res.status(409).json({
        error: 'An account with that username or email already exists.'
      });
    }

    const passwordHash = hashPassword(password);
    const defaultCalibration = calibrateMountOrientation();
    const nameToUse = (displayName && String(displayName).trim()) || cleanUsername;

    const insertResult = db
      .prepare(`
        INSERT INTO users (username, email, password_hash, display_name, driver_mode_preference, fsd_driver, body_sensitivity, calibration_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        cleanUsername,
        cleanEmail,
        passwordHash,
        nameToUse,
        driverModePreference,
        fsdDriver ? 1 : 0,
        bodySensitivity,
        JSON.stringify(defaultCalibration)
      );

    const userId = Number(insertResult.lastInsertRowid);

    // Create initial primary vehicle for the user
    let tpl = VEHICLE_TEMPLATES.find((t) => t.id === vehicleTemplateId);
    if (!tpl && !customVehicle) {
      tpl = VEHICLE_TEMPLATES[0];
    }

    if (customVehicle && customVehicle.make && customVehicle.model) {
      const tf = computeVehicleTransferFactor(customVehicle);
      db.prepare(`
        INSERT INTO vehicles (
          user_id, template_id, nickname, make, model, year, trim, category,
          suspension_type, suspension_label, wheel_diameter_inches, tire_sidewall_ratio,
          curb_weight_lbs, supports_fsd, fsd_hardware, suspension_damping_factor,
          lateral_roll_factor, seat_isolation_factor, is_primary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        userId,
        'custom',
        customVehicle.nickname || `${customVehicle.make} ${customVehicle.model}`,
        customVehicle.make,
        customVehicle.model,
        Number(customVehicle.year) || 2025,
        customVehicle.trim || 'Standard',
        customVehicle.category || 'Passenger Vehicle',
        customVehicle.suspensionType || 'coil_standard',
        customVehicle.suspensionLabel || 'Custom Suspension',
        Number(customVehicle.wheelDiameterInches) || 19,
        Number(customVehicle.tireSidewallRatio) || 45,
        Number(customVehicle.curbWeightLbs) || 4000,
        customVehicle.supportsFsd ? 1 : 0,
        customVehicle.fsdHardware || 'Manual / ADAS',
        tf.verticalFactor,
        tf.lateralFactor,
        tf.seatFactor
      );
    } else if (tpl) {
      db.prepare(`
        INSERT INTO vehicles (
          user_id, template_id, nickname, make, model, year, trim, category,
          suspension_type, suspension_label, wheel_diameter_inches, tire_sidewall_ratio,
          curb_weight_lbs, supports_fsd, fsd_hardware, suspension_damping_factor,
          lateral_roll_factor, seat_isolation_factor, is_primary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        userId,
        tpl.id,
        `${tpl.make} ${tpl.model}`,
        tpl.make,
        tpl.model,
        tpl.year,
        tpl.trim,
        tpl.category,
        tpl.suspensionType,
        tpl.suspensionLabel,
        tpl.wheelDiameterInches,
        tpl.tireSidewallRatio,
        tpl.curbWeightLbs,
        tpl.supportsFsd ? 1 : 0,
        tpl.fsdHardware,
        tpl.suspensionDampingFactor,
        tpl.lateralRollFactor,
        tpl.seatIsolationFactor
      );
    }

    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const vehicles = getUserVehicles(db, userId);
    const token = signJwt({ userId, username: userRow.username, email: userRow.email });

    res.cookie('sr_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000
    });

    return res.status(201).json({
      token,
      user: formatUserRow(userRow, vehicles)
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to register user: ${err.message}` });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', (req, res) => {
  try {
    const db = getDb();
    const { identifier, email, username, password } = req.body || {};
    const loginId = String(identifier || email || username || '').trim().toLowerCase();

    if (!loginId || !password) {
      return res.status(400).json({ error: 'Email/username and password are required.' });
    }

    const userRow = db
      .prepare('SELECT * FROM users WHERE lower(email) = ? OR lower(username) = ?')
      .get(loginId, loginId);

    if (!userRow || !verifyPassword(password, userRow.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials. Please check your username/email and password.' });
    }

    const vehicles = getUserVehicles(db, userRow.id);
    const token = signJwt({ userId: userRow.id, username: userRow.username, email: userRow.email });

    res.cookie('sr_token', token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000
    });

    return res.json({
      token,
      user: formatUserRow(userRow, vehicles)
    });
  } catch (err) {
    return res.status(500).json({ error: `Login error: ${err.message}` });
  }
});

/**
 * POST /api/auth/logout
 */
router.post('/logout', (_req, res) => {
  res.clearCookie('sr_token');
  return res.json({ success: true, message: 'Logged out successfully.' });
});

/**
 * GET /api/auth/me
 */
router.get('/me', requireAuth, (req, res) => {
  const db = getDb();
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!userRow) {
    return res.status(404).json({ error: 'User account not found.' });
  }
  const vehicles = getUserVehicles(db, userRow.id);
  return res.json({ user: formatUserRow(userRow, vehicles) });
});

/**
 * PUT /api/auth/profile
 */
router.put('/profile', requireAuth, (req, res) => {
  const db = getDb();
  const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.userId);
  if (!userRow) {
    return res.status(404).json({ error: 'User not found.' });
  }

  const {
    displayName,
    driverModePreference,
    fsdDriver,
    bodySensitivity,
    calibration
  } = req.body || {};

  const newDisplayName = displayName !== undefined ? String(displayName).trim() : userRow.display_name;
  const newMode = driverModePreference !== undefined ? driverModePreference : userRow.driver_mode_preference;
  const newFsd = fsdDriver !== undefined ? (fsdDriver ? 1 : 0) : userRow.fsd_driver;
  const newSens = bodySensitivity !== undefined ? bodySensitivity : userRow.body_sensitivity;
  const newCal = calibration !== undefined ? JSON.stringify(calibration) : userRow.calibration_json;

  db.prepare(`
    UPDATE users
    SET display_name = ?, driver_mode_preference = ?, fsd_driver = ?, body_sensitivity = ?, calibration_json = ?
    WHERE id = ?
  `).run(newDisplayName, newMode, newFsd, newSens, newCal, userRow.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(userRow.id);
  const vehicles = getUserVehicles(db, userRow.id);
  return res.json({ user: formatUserRow(updated, vehicles) });
});

module.exports = {
  router,
  getUserVehicles,
  formatUserRow
};
