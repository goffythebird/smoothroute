/**
 * SmoothRoute — Main Express Application & Server Entry Point
 */

require('dotenv').config();
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { getDb } = require('./db/database');
const { ensureSeeded } = require('./db/seed');
const { router: authRouter } = require('./routes/authRoutes');
const vehicleRouter = require('./routes/vehicleRoutes');
const tripRouter = require('./routes/tripRoutes');
const routePlannerRouter = require('./routes/routePlannerRoutes');

function createApp({ autoSeed = true } = {}) {
  const app = express();
  app.set('trust proxy', true);

  const db = getDb();
  if (autoSeed) {
    ensureSeeded(db);
  }

  // Automatically redirect any non-localhost HTTP request to HTTPS (301)
  app.use((req, res, next) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    const isLocal =
      host.startsWith('localhost') ||
      host.startsWith('127.0.0.1') ||
      host.startsWith('[::1]');

    let proto = req.headers['x-forwarded-proto'];
    if (!proto && req.headers['cf-visitor']) {
      try {
        const visitor = JSON.parse(req.headers['cf-visitor']);
        proto = visitor.scheme;
      } catch {
        // ignore
      }
    }

    if (!isLocal && proto === 'http') {
      return res.redirect(301, `https://${host}${req.originalUrl}`);
    }
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      strictTransportSecurity: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
      }
    })
  );
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Health & System Status endpoint
  app.get('/api/health', (_req, res) => {
    const dbConn = getDb();
    const routeCount = dbConn.prepare('SELECT COUNT(*) as c FROM public_routes').get().c;
    const tripCount = dbConn.prepare('SELECT COUNT(*) as c FROM trips').get().c;
    const hazardCount = dbConn.prepare('SELECT COUNT(*) as c FROM hazards').get().c;
    res.json({
      status: 'ok',
      app: 'SmoothRoute — Car & Phone G-Force Route Tracker & Tesla FSD Smooth Router',
      version: '1.0.0',
      stats: {
        publicRoutes: routeCount,
        recordedTrips: tripCount,
        mappedHazards: hazardCount
      },
      timestamp: new Date().toISOString()
    });
  });

  // API Routers
  app.use('/api/auth', authRouter);
  app.use('/api/vehicles', vehicleRouter);
  app.use('/api/trips', tripRouter);
  app.use('/api', routePlannerRouter);

  // Static Frontend & PWA assets
  const publicDir = path.join(__dirname, '../public');
  app.use(express.static(publicDir));

  // SPA fallback for client routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
    }
    return res.sendFile(path.join(publicDir, 'index.html'));
  });

  return app;
}

function startServer(port = Number(process.env.PORT || 3847), host = process.env.HOST || '0.0.0.0') {
  const app = createApp({ autoSeed: true });
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`SmoothRoute server listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
      resolve({ app, server });
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start SmoothRoute server:', err);
    process.exit(1);
  });
}

module.exports = {
  createApp,
  startServer
};
