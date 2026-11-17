/**
 * SmoothRoute — Database Initialization Helper
 * Starts with a clean, empty database (no fake/demo data).
 */

require('dotenv').config();
const { getDb } = require('./database');

function ensureSeeded(db = getDb()) {
  // Intentionally empty: SmoothRoute uses only real user accounts, cars, and recorded drives.
  void db;
  return { seeded: false, message: 'Clean database ready (no fake data).' };
}

if (require.main === module) {
  const db = getDb();
  db.exec('DELETE FROM hazards; DELETE FROM trips; DELETE FROM public_routes; DELETE FROM vehicles; DELETE FROM users;');
  console.log('Cleared all data. Database is completely clean.');
}

module.exports = {
  ensureSeeded
};
