/**
 * SmoothRoute — Vehicle Garage & Suspension Profile Routes
 */

const express = require('express');
const { getDb } = require('../db/database');
const { requireAuth } = require('../middleware/authMiddleware');
const { getUserVehicles } = require('./authRoutes');
const { VEHICLE_TEMPLATES, computeVehicleTransferFactor } = require('../physics/gforceEngine');

const router = express.Router();

/**
 * GET /api/vehicles/templates
 * Public catalog of pre-calibrated vehicles (Tesla FSD lineup + EVs + ICE benchmarks)
 */
router.get('/templates', (_req, res) => {
  return res.json({ templates: VEHICLE_TEMPLATES });
});

/**
 * GET /api/vehicles
 * List authenticated user's garage vehicles
 */
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const vehicles = getUserVehicles(db, req.user.userId);
  return res.json({ vehicles });
});

/**
 * POST /api/vehicles
 * Add a vehicle to the user's garage (from templateId or custom specs)
 */
router.post('/', requireAuth, (req, res) => {
  try {
    const db = getDb();
    const userId = req.user.userId;
    const {
      templateId,
      nickname,
      make,
      model,
      year,
      trim,
      category,
      suspensionType,
      suspensionLabel,
      wheelDiameterInches,
      tireSidewallRatio,
      curbWeightLbs,
      supportsFsd,
      fsdHardware,
      isPrimary = true
    } = req.body || {};

    const tpl = templateId ? VEHICLE_TEMPLATES.find((t) => t.id === templateId) : null;

    const finalMake = make || (tpl && tpl.make);
    const finalModel = model || (tpl && tpl.model);
    if (!finalMake || !finalModel) {
      return res.status(400).json({ error: 'Vehicle make and model (or a valid templateId) are required.' });
    }

    const finalYear = Number(year || (tpl && tpl.year) || 2025);
    const finalTrim = trim || (tpl && tpl.trim) || 'Standard';
    const finalCategory = category || (tpl && tpl.category) || 'Passenger Vehicle';
    const finalSuspType = suspensionType || (tpl && tpl.suspensionType) || 'coil_standard';
    const finalSuspLabel = suspensionLabel || (tpl && tpl.suspensionLabel) || 'Standard Coil Suspension';
    const finalWheel = Number(wheelDiameterInches || (tpl && tpl.wheelDiameterInches) || 19);
    const finalSidewall = Number(tireSidewallRatio || (tpl && tpl.tireSidewallRatio) || 45);
    const finalWeight = Number(curbWeightLbs || (tpl && tpl.curbWeightLbs) || 4200);
    const finalFsd = supportsFsd !== undefined ? Boolean(supportsFsd) : Boolean(tpl ? tpl.supportsFsd : finalMake.toLowerCase() === 'tesla');
    const finalHw = fsdHardware || (tpl && tpl.fsdHardware) || (finalFsd ? 'HW4 / AI4' : 'Manual / ADAS');

    const transfer = tpl && !suspensionType && !wheelDiameterInches
      ? {
          verticalFactor: tpl.suspensionDampingFactor,
          lateralFactor: tpl.lateralRollFactor,
          seatFactor: tpl.seatIsolationFactor
        }
      : computeVehicleTransferFactor({
          suspensionType: finalSuspType,
          wheelDiameterInches: finalWheel,
          tireSidewallRatio: finalSidewall
        });

    if (isPrimary) {
      db.prepare('UPDATE vehicles SET is_primary = 0 WHERE user_id = ?').run(userId);
    }

    const result = db.prepare(`
      INSERT INTO vehicles (
        user_id, template_id, nickname, make, model, year, trim, category,
        suspension_type, suspension_label, wheel_diameter_inches, tire_sidewall_ratio,
        curb_weight_lbs, supports_fsd, fsd_hardware, suspension_damping_factor,
        lateral_roll_factor, seat_isolation_factor, is_primary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      tpl ? tpl.id : 'custom',
      nickname || `${finalYear} ${finalMake} ${finalModel}`,
      finalMake,
      finalModel,
      finalYear,
      finalTrim,
      finalCategory,
      finalSuspType,
      finalSuspLabel,
      finalWheel,
      finalSidewall,
      finalWeight,
      finalFsd ? 1 : 0,
      finalHw,
      transfer.verticalFactor,
      transfer.lateralFactor,
      transfer.seatFactor,
      isPrimary ? 1 : 0
    );

    const vehicles = getUserVehicles(db, userId);
    const created = vehicles.find((v) => v.id === Number(result.lastInsertRowid));
    return res.status(201).json({ vehicle: created, vehicles });
  } catch (err) {
    return res.status(500).json({ error: `Failed to add vehicle: ${err.message}` });
  }
});

/**
 * PUT /api/vehicles/:id/primary
 * Set a vehicle as the user's primary active car
 */
router.put('/:id/primary', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const vehicleId = Number(req.params.id);

  const row = db.prepare('SELECT id FROM vehicles WHERE id = ? AND user_id = ?').get(vehicleId, userId);
  if (!row) {
    return res.status(404).json({ error: 'Vehicle not found in your garage.' });
  }

  db.prepare('UPDATE vehicles SET is_primary = 0 WHERE user_id = ?').run(userId);
  db.prepare('UPDATE vehicles SET is_primary = 1 WHERE id = ? AND user_id = ?').run(vehicleId, userId);

  const vehicles = getUserVehicles(db, userId);
  return res.json({ vehicles });
});

/**
 * DELETE /api/vehicles/:id
 */
router.delete('/:id', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.user.userId;
  const vehicleId = Number(req.params.id);

  const existing = db.prepare('SELECT * FROM vehicles WHERE id = ? AND user_id = ?').get(vehicleId, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Vehicle not found in your garage.' });
  }

  db.prepare('DELETE FROM vehicles WHERE id = ? AND user_id = ?').run(vehicleId, userId);

  // Ensure another vehicle is marked primary if the primary was deleted
  const remaining = db.prepare('SELECT id FROM vehicles WHERE user_id = ? ORDER BY id ASC').all(userId);
  if (remaining.length > 0 && existing.is_primary) {
    db.prepare('UPDATE vehicles SET is_primary = 1 WHERE id = ?').run(remaining[0].id);
  }

  const vehicles = getUserVehicles(db, userId);
  return res.json({ vehicles });
});

module.exports = router;
