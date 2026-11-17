# Contributing to SmoothRoute

Thank you for helping inform the public about road G-forces, biomechanical body wear, and smoother routes for Tesla FSD and everyday drivers!

## Ways to Contribute

1. **Add New Vehicle Suspension Profiles (`src/physics/gforceEngine.js`)**:
   - Add new entries to `VEHICLE_TEMPLATES` with calibrated `suspensionDampingFactor` ($\kappa_{\text{vert}}$), `lateralRollFactor` ($\kappa_{\text{lat}}$), `seatIsolationFactor`, wheel diameter, and tire sidewall aspect ratio.
2. **Contribute Public Route Telemetry**:
   - Record drives using the Phone G-Force Cockpit and export `.json`, `.csv`, or `.gpx` telemetry traces.
3. **Improve Biomechanical & FSD Scoring Models**:
   - Enhance the ISO 2631-1 Whole-Body Vibration (WBV) and Vibration Dose Value ($\text{VDV}$) weighting curves.

## Development Workflow

```bash
git clone https://github.com/goffythebird/smoothroute.git
cd smoothroute
cp .env.example .env
# Set a random JWT_SECRET in .env
npm install
npm run seed
npm test
npm start
```

Before opening a Pull Request, always run:
```bash
npm test
npm run audit:secrets
```
