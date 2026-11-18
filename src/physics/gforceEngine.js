/**
 * SmoothRoute — Physics, Vehicle Suspension & Biomechanical G-Force Engine
 *
 * Implements:
 * 1. 3-Axis Phone Accelerometer Mount Calibration & Vehicle Frame Transformation
 * 2. Vehicle Suspension & Tire Sidewall Transfer Function (Cabin G <-> True Road Roughness)
 * 3. ISO 2631-1 Whole-Body Vibration (WBV), 4th-Power Vibration Dose Value (VDV) & Spine Wear Index
 * 4. Tesla FSD Smoothness Score & Autonomous Comfort Rating
 * 5. Automated G-Force Hazard Detection (Potholes, Bridge Joints, Hard/Phantom Brakes, High-G Curves)
 */

const G0 = 9.80665; // Standard gravity in m/s^2
const { iriToNormalizedMetrics, normalizedGToIri } = require('./usHighwayBaselines');

/**
 * Pre-configured vehicle catalog with realistic suspension damping & chassis transfer factors.
 *
 * suspensionDampingFactor (kappa_vert):
 *   1.00 = Standard reference midsize vehicle
 *   < 1.00 = Softer/air suspension absorbs more vertical road shock (lower cabin G for same road)
 *   > 1.00 = Stiffer sport suspension / low-profile tires transmit more vertical road shock to cabin
 */
const VEHICLE_TEMPLATES = [
  {
    id: 'tesla-model-3-highland-lr',
    make: 'Tesla',
    model: 'Model 3 (Highland)',
    year: 2025,
    trim: 'Long Range AWD (18" Photon)',
    category: 'EV Sedan',
    suspensionType: 'frequency_selective_damping',
    suspensionLabel: 'Frequency Selective Damping (Comfort Tuned)',
    wheelDiameterInches: 18,
    tireSidewallRatio: 45,
    curbWeightLbs: 4030,
    supportsFsd: true,
    fsdHardware: 'HW4 / AI4',
    suspensionDampingFactor: 0.92,
    lateralRollFactor: 0.90,
    seatIsolationFactor: 0.93,
    description: 'Refreshed Highland acoustic & frequency-selective dampers; balanced FSD cruiser.'
  },
  {
    id: 'tesla-model-3-perf',
    make: 'Tesla',
    model: 'Model 3 Performance',
    year: 2025,
    trim: 'Performance AWD (20" Warp)',
    category: 'EV Sport Sedan',
    suspensionType: 'adaptive_sport',
    suspensionLabel: 'Adaptive Sport Coilovers (20" Low-Profile)',
    wheelDiameterInches: 20,
    tireSidewallRatio: 30,
    curbWeightLbs: 4054,
    supportsFsd: true,
    fsdHardware: 'HW4 / AI4',
    suspensionDampingFactor: 1.24,
    lateralRollFactor: 0.78,
    seatIsolationFactor: 0.98,
    description: 'Ultra-thin 30-series tires transmit high vertical G spikes over potholes and expansion joints.'
  },
  {
    id: 'tesla-model-y-lr',
    make: 'Tesla',
    model: 'Model Y',
    year: 2025,
    trim: 'Long Range AWD (19" Gemini)',
    category: 'EV Crossover SUV',
    suspensionType: 'coil_comfort',
    suspensionLabel: 'Comfort Retuned Coil Suspension',
    wheelDiameterInches: 19,
    tireSidewallRatio: 45,
    curbWeightLbs: 4363,
    supportsFsd: true,
    fsdHardware: 'HW4 / AI4',
    suspensionDampingFactor: 1.06,
    lateralRollFactor: 1.04,
    seatIsolationFactor: 0.95,
    description: 'Most popular FSD vehicle; slightly firm rear axle rebound over sharp speed humps.'
  },
  {
    id: 'tesla-model-y-perf',
    make: 'Tesla',
    model: 'Model Y Performance',
    year: 2024,
    trim: 'Performance AWD (21" Uberturbine)',
    category: 'EV Sport SUV',
    suspensionType: 'coil_sport',
    suspensionLabel: 'Lowered Sport Coilovers (21" Uberturbine)',
    wheelDiameterInches: 21,
    tireSidewallRatio: 35,
    curbWeightLbs: 4416,
    supportsFsd: true,
    fsdHardware: 'HW4 / AI4',
    suspensionDampingFactor: 1.28,
    lateralRollFactor: 0.88,
    seatIsolationFactor: 1.00,
    description: 'Stiff chassis and 21-inch wheels amplify rough pavement G-forces; benefits hugely from SmoothRoute.'
  },
  {
    id: 'tesla-model-s-lr',
    make: 'Tesla',
    model: 'Model S',
    year: 2025,
    trim: 'Dual Motor Air Suspension (19" Tempest)',
    category: 'EV Flagship Sedan',
    suspensionType: 'air_adaptive',
    suspensionLabel: 'Predictive Adaptive Air Suspension',
    wheelDiameterInches: 19,
    tireSidewallRatio: 45,
    curbWeightLbs: 4560,
    supportsFsd: true,
    fsdHardware: 'HW4 / AI4',
    suspensionDampingFactor: 0.78,
    lateralRollFactor: 0.84,
    seatIsolationFactor: 0.86,
    description: 'Plush adaptive air springs isolate up to 22% more vertical road G-shock than standard coil springs.'
  },
  {
    id: 'tesla-model-x-lr',
    make: 'Tesla',
    model: 'Model X',
    year: 2025,
    trim: 'Dual Motor Air Suspension (20" Cyberstream)',
    category: 'EV Luxury SUV',
    suspensionType: 'air_adaptive',
    suspensionLabel: 'Adaptive Air Suspension',
    wheelDiameterInches: 20,
    tireSidewallRatio: 45,
    curbWeightLbs: 5148,
    supportsFsd: true,
    fsdHardware: 'HW4 / AI4',
    suspensionDampingFactor: 0.83,
    lateralRollFactor: 0.96,
    seatIsolationFactor: 0.88,
    description: 'Heavy luxury EV SUV with air suspension; smooth over ripples but sensitive to lateral body roll in sharp turns.'
  },
  {
    id: 'tesla-cybertruck-awd',
    make: 'Tesla',
    model: 'Cybertruck',
    year: 2025,
    trim: 'All-Wheel Drive (35" All-Terrain)',
    category: 'EV Pickup Truck',
    suspensionType: 'air_adaptive',
    suspensionLabel: '12" Travel Adaptive Air + Rear Steer',
    wheelDiameterInches: 20,
    tireSidewallRatio: 65,
    curbWeightLbs: 6603,
    supportsFsd: true,
    fsdHardware: 'HW4 / AI4',
    suspensionDampingFactor: 0.85,
    lateralRollFactor: 0.92,
    seatIsolationFactor: 0.90,
    description: 'Tall sidewall 35" tires and long-travel air dampers soak up deep potholes effortlessly.'
  },
  {
    id: 'rivian-r1s',
    make: 'Rivian',
    model: 'R1S',
    year: 2025,
    trim: 'Dual Max (21" Road)',
    category: 'EV Adventure SUV',
    suspensionType: 'air_adaptive',
    suspensionLabel: 'Independent Air Suspension + Hydraulic Roll Control',
    wheelDiameterInches: 21,
    tireSidewallRatio: 55,
    curbWeightLbs: 6800,
    supportsFsd: false,
    fsdHardware: 'Highway Assist',
    suspensionDampingFactor: 0.88,
    lateralRollFactor: 0.91,
    seatIsolationFactor: 0.91,
    description: 'Heavy adventure SUV with hydraulic cross-linked dampers.'
  },
  {
    id: 'bmw-i4-edrive40',
    make: 'BMW',
    model: 'i4 eDrive40',
    year: 2025,
    trim: 'Gran Coupe (Rear Air Springs)',
    category: 'EV Sport Sedan',
    suspensionType: 'coil_standard',
    suspensionLabel: 'Front Strut / Rear Self-Leveling Air',
    wheelDiameterInches: 19,
    tireSidewallRatio: 40,
    curbWeightLbs: 4680,
    supportsFsd: false,
    fsdHardware: 'Driving Assistant Pro',
    suspensionDampingFactor: 0.96,
    lateralRollFactor: 0.85,
    seatIsolationFactor: 0.92,
    description: 'Taut German chassis tuning with self-leveling rear air springs.'
  },
  {
    id: 'toyota-prius-ltd',
    make: 'Toyota',
    model: 'Prius',
    year: 2025,
    trim: 'Limited (19" Alloy)',
    category: 'Hybrid Commuter',
    suspensionType: 'coil_standard',
    suspensionLabel: 'MacPherson Strut / Multi-Link Coil',
    wheelDiameterInches: 19,
    tireSidewallRatio: 50,
    curbWeightLbs: 3285,
    supportsFsd: false,
    fsdHardware: 'TSS 3.0',
    suspensionDampingFactor: 1.02,
    lateralRollFactor: 1.05,
    seatIsolationFactor: 0.97,
    description: 'Reference commuter hatchback with standard coil spring damping.'
  },
  {
    id: 'porsche-911-carrera',
    make: 'Porsche',
    model: '911 Carrera',
    year: 2025,
    trim: 'PASM Sport (20"/21")',
    category: 'Sports Car',
    suspensionType: 'track_stiff',
    suspensionLabel: 'PASM Sport Chassis (-10mm)',
    wheelDiameterInches: 21,
    tireSidewallRatio: 30,
    curbWeightLbs: 3354,
    supportsFsd: false,
    fsdHardware: 'Manual / Cruise',
    suspensionDampingFactor: 1.42,
    lateralRollFactor: 0.68,
    seatIsolationFactor: 1.05,
    description: 'High-precision stiff sports chassis; transmits high vertical G on broken city asphalt.'
  },
  {
    id: 'mercedes-sprinter-camper-2500',
    make: 'Mercedes-Benz',
    model: 'Sprinter 2500 Camper Van',
    year: 2025,
    trim: '170" WB AWD Adventure Conversion',
    category: 'RV / Camper Van',
    suspensionType: 'rv_camper_van',
    suspensionLabel: 'Heavy-Duty Van Strut / Rear Leaf Pack',
    wheelDiameterInches: 17,
    tireSidewallRatio: 70,
    curbWeightLbs: 8400,
    supportsFsd: false,
    fsdHardware: 'DISTRONIC Highway Assist',
    suspensionDampingFactor: 1.14,
    lateralRollFactor: 1.22,
    seatIsolationFactor: 0.96,
    description: 'High-roof camper conversion; sensitive to bridge joint cabinetry rattle and highway crosswind roll.'
  },
  {
    id: 'class-a-diesel-pusher-40ft',
    make: 'Newmar / Tiffin',
    model: '40ft Class A Diesel Pusher',
    year: 2025,
    trim: 'Full Air-Ride Coach (22.5" Commercial)',
    category: 'Class A Motorhome',
    suspensionType: 'rv_air_coach',
    suspensionLabel: '8-Bag Heavy Coach Air Suspension + ComfortSteer',
    wheelDiameterInches: 22.5,
    tireSidewallRatio: 70,
    curbWeightLbs: 36500,
    supportsFsd: false,
    fsdHardware: 'Highway Lane Assist',
    suspensionDampingFactor: 0.94,
    lateralRollFactor: 1.18,
    seatIsolationFactor: 0.88,
    description: 'Plush air bags over normal ripples, but long overhang pitches violently on sunken interstate viaduct joints.'
  },
  {
    id: 'class-c-motorhome-e450',
    make: 'Winnebago / Jayco',
    model: '31ft Class C Motorhome',
    year: 2025,
    trim: 'Ford E-450 Cutaway Chassis (Dual Rear Wheel)',
    category: 'Class C Motorhome',
    suspensionType: 'truck_leaf',
    suspensionLabel: 'Heavy-Duty Commercial Twin-I-Beam / Multi-Leaf',
    wheelDiameterInches: 16,
    tireSidewallRatio: 75,
    curbWeightLbs: 14200,
    supportsFsd: false,
    fsdHardware: 'Adaptive Cruise',
    suspensionDampingFactor: 1.32,
    lateralRollFactor: 1.25,
    seatIsolationFactor: 1.02,
    description: 'Stiff commercial cutaway leaf springs transmit severe vertical jounce to coach cabinetry and spine.'
  },
  {
    id: 'ford-f250-fifth-wheel-tow',
    make: 'Ford',
    model: 'F-250 Super Duty (Fifth-Wheel Rig)',
    year: 2025,
    trim: 'PowerStroke 4x4 + 35ft Fifth-Wheel Trailer',
    category: 'Heavy Tow Rig',
    suspensionType: 'truck_leaf',
    suspensionLabel: 'Solid Front Axle + Heavy Tow Leaf Pack',
    wheelDiameterInches: 20,
    tireSidewallRatio: 60,
    curbWeightLbs: 18500,
    supportsFsd: false,
    fsdHardware: 'BlueCruise Tow Mode',
    suspensionDampingFactor: 1.26,
    lateralRollFactor: 1.08,
    seatIsolationFactor: 0.99,
    description: '3/4-ton tow suspension experiences longitudinal pin-box "chucking" on spaced concrete highway slabs.'
  },
  {
    id: 'lexus-ls500h-spine-saver',
    make: 'Lexus / Mercedes',
    model: 'LS 500h / S-Class Spine-Saver',
    year: 2025,
    trim: 'Executive Adaptive Air + Orthopedic Seat Isolation',
    category: 'Medical / Spine-Saver Sedan',
    suspensionType: 'air_adaptive',
    suspensionLabel: 'Road-Preview Active Air Suspension (18" Touring)',
    wheelDiameterInches: 18,
    tireSidewallRatio: 50,
    curbWeightLbs: 4920,
    supportsFsd: false,
    fsdHardware: 'Teammate / Drive Pilot',
    suspensionDampingFactor: 0.74,
    lateralRollFactor: 0.82,
    seatIsolationFactor: 0.82,
    description: 'Maximum vertical shock isolation for sciatica, post-surgery recovery, and chronic lumbar protection.'
  }
];

/**
 * Compute custom vehicle suspension damping factor from car specifications
 * if user creates a custom car not directly copied from a template.
 */
function computeVehicleTransferFactor(vehicle = {}) {
  if (typeof vehicle.suspensionDampingFactor === 'number' && vehicle.suspensionDampingFactor > 0.3) {
    return {
      verticalFactor: Number(vehicle.suspensionDampingFactor.toFixed(3)),
      lateralFactor: Number((vehicle.lateralRollFactor || 1.0).toFixed(3)),
      seatFactor: Number((vehicle.seatIsolationFactor || 0.95).toFixed(3))
    };
  }

  const suspensionBase = {
    air_adaptive: 0.80,
    frequency_selective_damping: 0.92,
    rv_air_coach: 0.94,
    coil_comfort: 0.95,
    coil_standard: 1.00,
    rv_camper_van: 1.14,
    truck_leaf: 1.15,
    adaptive_sport: 1.18,
    coil_sport: 1.24,
    track_stiff: 1.38
  }[vehicle.suspensionType] || 1.00;

  const wheel = Number(vehicle.wheelDiameterInches) || 19;
  const sidewall = Number(vehicle.tireSidewallRatio) || 45;

  // Larger wheels & thinner sidewalls increase high-frequency vertical shock transmission
  const wheelAdjustment = (wheel - 19) * 0.035;
  const sidewallAdjustment = (45 - sidewall) * 0.006;

  const verticalFactor = Math.max(0.65, Math.min(1.65, suspensionBase + wheelAdjustment + sidewallAdjustment));
  const lateralFactor = Math.max(0.65, Math.min(1.40, 1.0 - (verticalFactor - 1.0) * 0.35));

  return {
    verticalFactor: Number(verticalFactor.toFixed(3)),
    lateralFactor: Number(lateralFactor.toFixed(3)),
    seatFactor: 0.95
  };
}

/**
 * Calibrate 3-axis phone mount orientation from stationary gravity readings.
 * Accepts an array of raw accelerometer samples [{ ax, ay, az }] in m/s^2 (including gravity)
 * and computes the gravity baseline vector and orthonormal basis vectors (eLat, eLon, eVert).
 */
function calibrateMountOrientation(samples = []) {
  if (!Array.isArray(samples) || samples.length === 0) {
    // Default upright dash mount (~70 deg tilt)
    samples = [{ ax: 0, ay: 9.215, az: 3.354 }];
  }

  let sumX = 0, sumY = 0, sumZ = 0;
  for (const s of samples) {
    sumX += Number(s.ax) || 0;
    sumY += Number(s.ay) || 0;
    sumZ += Number(s.az) || 0;
  }
  const n = samples.length;
  const gx = sumX / n;
  const gy = sumY / n;
  const gz = sumZ / n;
  const mag = Math.hypot(gx, gy, gz) || G0;

  // Unit vertical vector (pointing parallel to gravity reaction)
  const eVert = [gx / mag, gy / mag, gz / mag];

  // Choose phone X-axis [1, 0, 0] as initial lateral reference, orthogonalize against eVert
  let refLat = [1, 0, 0];
  if (Math.abs(eVert[0]) > 0.9) {
    refLat = [0, 1, 0];
  }
  const dotLat = refLat[0] * eVert[0] + refLat[1] * eVert[1] + refLat[2] * eVert[2];
  let eLat = [
    refLat[0] - dotLat * eVert[0],
    refLat[1] - dotLat * eVert[1],
    refLat[2] - dotLat * eVert[2]
  ];
  const latMag = Math.hypot(eLat[0], eLat[1], eLat[2]) || 1;
  eLat = [eLat[0] / latMag, eLat[1] / latMag, eLat[2] / latMag];

  // eLon = eVert x eLat (right-handed vehicle frame)
  const eLon = [
    eVert[1] * eLat[2] - eVert[2] * eLat[1],
    eVert[2] * eLat[0] - eVert[0] * eLat[2],
    eVert[0] * eLat[1] - eVert[1] * eLat[0]
  ];

  // Compute pitch & roll angles in degrees for UI display
  const pitchDeg = Number((Math.atan2(gy, gz) * (180 / Math.PI)).toFixed(1));
  const rollDeg = Number((Math.atan2(-gx, Math.hypot(gy, gz)) * (180 / Math.PI)).toFixed(1));

  return {
    gravityBaseline: { gx: Number(gx.toFixed(4)), gy: Number(gy.toFixed(4)), gz: Number(gz.toFixed(4)), magnitude: Number(mag.toFixed(4)) },
    basis: { eLat, eLon, eVert },
    mountAngles: { pitchDeg, rollDeg }
  };
}

/**
 * Transform a raw phone accelerometer reading (ax, ay, az in m/s^2 including gravity)
 * into vehicle-frame dynamic G-forces (gLon, gLat, gVert, gTotal) using mount calibration.
 */
function transformPhoneToVehicleG(rawSample, calibration) {
  const cal = calibration && calibration.gravityBaseline ? calibration : calibrateMountOrientation();
  const { gx, gy, gz } = cal.gravityBaseline;
  const { eLat, eLon, eVert } = cal.basis;

  const dx = (Number(rawSample.ax) || 0) - gx;
  const dy = (Number(rawSample.ay) || 0) - gy;
  const dz = (Number(rawSample.az) || 0) - gz;

  const aLon = dx * eLon[0] + dy * eLon[1] + dz * eLon[2];
  const aLat = dx * eLat[0] + dy * eLat[1] + dz * eLat[2];
  const aVert = dx * eVert[0] + dy * eVert[1] + dz * eVert[2];

  const gLon = aLon / G0;
  const gLat = aLat / G0;
  const gVert = aVert / G0;
  const gTotal = Math.hypot(gLon, gLat, gVert);

  return {
    gLon: Number(gLon.toFixed(4)),
    gLat: Number(gLat.toFixed(4)),
    gVert: Number(gVert.toFixed(4)),
    gTotal: Number(gTotal.toFixed(4))
  };
}

/**
 * Analyze a stream of trip telemetry samples and compute full biomechanical body wear,
 * ISO 2631-1 Whole-Body Vibration (WBV), Vibration Dose Value (VDV), Jerk, and Tesla FSD Smoothness.
 *
 * Each sample in `samples` can contain:
 *   { timestampMs, gLon, gLat, gVert, speedMph, lat, lng, fsdActive }
 *
 * @param {Array} samples - Telemetry points
 * @param {Object} vehicle - Vehicle profile for suspension transfer normalization
 */
/**
 * Filter out start/end phone-handling spikes (tapping Start/Stop or setting phone into mount at <3 mph)
 * and remove slow mount-tilt / road-grade DC gravity drift on real multi-minute drives.
 */
function sanitizeAndDetrendSamples(rawSamples = []) {
  if (!Array.isArray(rawSamples) || rawSamples.length <= 4) {
    return rawSamples;
  }

  const n = rawSamples.length;
  const hasRealGpsMovement = rawSamples.some((s) => (Number(s.speedMph) || 0) >= 5);

  // 1. Trim start/end phone-handling artifacts on real drives (>20 samples)
  let filtered = rawSamples;
  if (n >= 20) {
    const headCutoff = Math.min(12, Math.floor(n * 0.04));
    const tailStart = Math.max(headCutoff, n - Math.min(10, Math.floor(n * 0.03)));
    filtered = rawSamples.filter((s, idx) => {
      const spd = Number(s.speedMph) || 0;
      const gTot = Number(s.gTotal) || Math.hypot(Number(s.gLon) || 0, Number(s.gLat) || 0, Number(s.gVert) || 0);
      // Drop pre-calibration / phone-placement spike at the very start or pickup at the very end
      if (idx < headCutoff && (gTot > 0.42 || (hasRealGpsMovement && spd < 2))) return false;
      if (idx >= tailStart && (gTot > 0.42 || (hasRealGpsMovement && spd < 2))) return false;
      // Drop impossible >1.2G spike while stationary (0-2 mph)
      if (hasRealGpsMovement && spd < 2 && gTot > 0.55) return false;
      return true;
    });
    if (filtered.length < 4) filtered = rawSamples;
  }

  // 2. If average |gLon| or |gLat| across a real drive (>50 samples) has a static mount-tilt DC offset (>0.08G),
  // apply a slow exponential moving average high-pass filter so mount shifts don't masquerade as constant braking.
  if (filtered.length >= 50) {
    const meanLon = filtered.reduce((acc, s) => acc + (Number(s.gLon) || 0), 0) / filtered.length;
    const meanLat = filtered.reduce((acc, s) => acc + (Number(s.gLat) || 0), 0) / filtered.length;
    const meanVert = filtered.reduce((acc, s) => acc + (Number(s.gVert) || 0), 0) / filtered.length;

    if (Math.abs(meanLon) > 0.08 || Math.abs(meanLat) > 0.08 || Math.abs(meanVert) > 0.08) {
      let emaLon = Number(filtered[0].gLon) || 0;
      let emaLat = Number(filtered[0].gLat) || 0;
      let emaVert = Number(filtered[0].gVert) || 0;
      const alpha = 0.93;

      filtered = filtered.map((s) => {
        const rawLon = Number(s.gLon) || 0;
        const rawLat = Number(s.gLat) || 0;
        const rawVert = Number(s.gVert) || 0;
        emaLon = alpha * emaLon + (1 - alpha) * rawLon;
        emaLat = alpha * emaLat + (1 - alpha) * rawLat;
        emaVert = alpha * emaVert + (1 - alpha) * rawVert;

        const gLon = Number((rawLon - emaLon).toFixed(4));
        const gLat = Number((rawLat - emaLat).toFixed(4));
        const gVert = Number((rawVert - emaVert).toFixed(4));
        const gTotal = Number(Math.hypot(gLon, gLat, gVert).toFixed(4));
        return { ...s, gLon, gLat, gVert, gTotal };
      });
    }
  }

  return filtered;
}

function analyzeTripBiomechanics(rawSamples = [], vehicle = {}) {
  const samples = sanitizeAndDetrendSamples(rawSamples);
  const transfer = computeVehicleTransferFactor(vehicle);

  if (!Array.isArray(samples) || samples.length === 0) {
    return {
      sampleCount: 0,
      durationSec: 0,
      distanceMiles: 0,
      peakGLon: 0,
      peakGLat: 0,
      peakGVert: 0,
      peakGTotal: 0,
      avgDynamicG: 0,
      rmsGVert: 0,
      rmsGTotal: 0,
      normalizedRoadRoughnessG: 0,
      peakJerkGPerSec: 0,
      avgJerkGPerSec: 0,
      isoWeightedRmsMps2: 0,
      vibrationDoseValueVdv: 0,
      spineMicroShocksCount: 0,
      severeShockCount: 0,
      hardBrakeCount: 0,
      bodyWearScore: 0,
      bodyWearGrade: 'Minimal',
      smoothnessScore: 100,
      fsdComfortScore: 100,
      fsdGrade: 'S+ Ultra Smooth',
      fsdRecommendation: 'Ideal route for Tesla FSD and high-comfort travel.',
      vehicleTransferFactor: transfer.verticalFactor
    };
  }

  let peakGLon = 0;
  let peakGLat = 0;
  let peakGVert = 0;
  let peakGTotal = 0;
  let sumGTotal = 0;
  let sumSqGVert = 0;
  let sumSqGTotal = 0;

  let sumIsoWeightedSq = 0;
  let vdvIntegral = 0; // sum(a_w^4 * dt)
  let totalDtSec = 0;

  let sumJerk = 0;
  let peakJerk = 0;
  let jerkSamples = 0;

  let spineMicroShocksCount = 0; // |gVert| >= 0.30G
  let severeShockCount = 0;      // |gVert| >= 0.50G
  let hardBrakeCount = 0;        // gLon <= -0.38G
  let distanceMiles = 0;

  let lastShockTime = -Infinity;
  let lastBrakeTime = -Infinity;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const gLon = Number(s.gLon) || 0;
    const gLat = Number(s.gLat) || 0;
    const gVert = Number(s.gVert) || 0;
    const gTotal = Number(s.gTotal) || Math.hypot(gLon, gLat, gVert);

    const absLon = Math.abs(gLon);
    const absLat = Math.abs(gLat);
    const absVert = Math.abs(gVert);

    if (absLon > peakGLon) peakGLon = absLon;
    if (absLat > peakGLat) peakGLat = absLat;
    if (absVert > peakGVert) peakGVert = absVert;
    if (gTotal > peakGTotal) peakGTotal = gTotal;

    sumGTotal += gTotal;
    sumSqGVert += gVert * gVert;
    sumSqGTotal += gTotal * gTotal;

    // Determine time step dt in seconds
    let dt = 0.1; // default 10Hz (0.1s)
    if (i > 0) {
      const tCurr = Number(s.timestampMs) || 0;
      const tPrev = Number(samples[i - 1].timestampMs) || 0;
      if (tCurr > tPrev) {
        dt = Math.min(2.0, Math.max(0.01, (tCurr - tPrev) / 1000));
      }

      // Compute 3D Jerk (dG/dt in G/s)
      const prev = samples[i - 1];
      const dLon = gLon - (Number(prev.gLon) || 0);
      const dLat = gLat - (Number(prev.gLat) || 0);
      const dVert = gVert - (Number(prev.gVert) || 0);
      // Cap instantaneous dt denominator at 0.05s minimum to avoid noise blowup
      const jerkDt = Math.max(0.08, Math.min(0.5, dt));
      const jerk = Math.hypot(dLon, dLat, dVert) / jerkDt;
      sumJerk += jerk;
      if (jerk > peakJerk) peakJerk = jerk;
      jerkSamples++;

      // Accumulate GPS distance if lat/lng present, else integrate speedMph
      if (typeof s.lat === 'number' && typeof prev.lat === 'number' && (s.lat !== prev.lat || s.lng !== prev.lng)) {
        distanceMiles += haversineMiles(prev.lat, prev.lng, s.lat, s.lng);
      } else if (typeof s.speedMph === 'number' && s.speedMph > 0) {
        distanceMiles += (s.speedMph * dt) / 3600;
      }
    }
    totalDtSec += dt;

    // ISO 2631-1 Whole-Body Vibration frequency-weighted acceleration (m/s^2)
    // Horizontal axes multiplied by k=1.4, vertical axis by k=1.0, damped by seat isolation factor
    const seatFactor = transfer.seatFactor || 0.95;
    const awLon = 1.4 * gLon * G0 * seatFactor;
    const awLat = 1.4 * gLat * G0 * seatFactor;
    const awVert = 1.0 * gVert * G0 * seatFactor;
    const awTotalSq = awLon * awLon + awLat * awLat + awVert * awVert;
    const awTotal = Math.sqrt(awTotalSq);

    sumIsoWeightedSq += awTotalSq * dt;
    vdvIntegral += Math.pow(awTotal, 4) * dt;

    const tSec = totalDtSec;
    // Debounce shock events by 0.6s so a single pothole oscillation isn't counted 5 times
    if (absVert >= 0.30 && (tSec - lastShockTime) >= 0.6) {
      spineMicroShocksCount++;
      if (absVert >= 0.50) {
        severeShockCount++;
      }
      lastShockTime = tSec;
    }

    if (gLon <= -0.38 && (tSec - lastBrakeTime) >= 1.2) {
      hardBrakeCount++;
      lastBrakeTime = tSec;
    }
  }

  const n = samples.length;
  const avgDynamicG = sumGTotal / n;
  const rmsGVert = Math.sqrt(sumSqGVert / n);
  const rmsGTotal = Math.sqrt(sumSqGTotal / n);
  const avgJerkGPerSec = jerkSamples > 0 ? sumJerk / jerkSamples : 0;

  // Normalize vertical road roughness to the reference vehicle (kappa = 1.00)
  // so that public route comparisons know the true road surface quality regardless of the recording car
  const normalizedRoadRoughnessG = rmsGVert / (transfer.verticalFactor || 1.0);

  const isoWeightedRmsMps2 = totalDtSec > 0 ? Math.sqrt(sumIsoWeightedSq / totalDtSec) : 0;
  const vibrationDoseValueVdv = Math.pow(vdvIntegral, 0.25);

  // Compute Biomechanical Body Wear Score (0 = zero wear, 100 = extreme orthopedic stress)
  // Combines ISO 2631-1 VDV (action threshold ~8.5, limit ~17), RMS vertical G, and spine micro-shocks
  const vdvComponent = Math.min(45, (vibrationDoseValueVdv / 12.0) * 45);
  const rmsComponent = Math.min(30, (rmsGVert / 0.22) * 30);
  const shockComponent = Math.min(25, spineMicroShocksCount * 2.2 + severeShockCount * 4.5);
  const bodyWearScore = Math.round(Math.max(1, Math.min(100, vdvComponent + rmsComponent + shockComponent)));

  let bodyWearGrade = 'Minimal Wear';
  if (bodyWearScore >= 75) bodyWearGrade = 'Severe Orthopedic Stress';
  else if (bodyWearScore >= 52) bodyWearGrade = 'High Body Wear';
  else if (bodyWearScore >= 30) bodyWearGrade = 'Moderate Body Wear';
  else if (bodyWearScore >= 14) bodyWearGrade = 'Low Body Wear';

  // Compute Road Smoothness Score (0-100, higher is smoother)
  const rawPenalty =
    (rmsGVert * 145) +
    (Math.max(0, peakGVert - 0.18) * 32) +
    (spineMicroShocksCount * 1.8) +
    (severeShockCount * 4.5) +
    (avgJerkGPerSec * 4.0);
  const smoothnessScore = Math.round(Math.max(5, Math.min(100, 100 - rawPenalty)));

  // Compute Tesla FSD Smoothness & Comfort Score (0-100)
  // FSD drivers care deeply about:
  //  1) Smooth asphalt with minimal potholes (vertical shocks)
  //  2) Low longitudinal jerk / zero phantom brake zones
  //  3) Gentle lateral curvature without harsh lateral snaps
  const fsdPenalty =
    (rmsGVert * 120) +
    (hardBrakeCount * 6.5) +
    (Math.max(0, peakGLat - 0.25) * 38) +
    (avgJerkGPerSec * 6.2) +
    (severeShockCount * 5.5);
  const fsdComfortScore = Math.round(Math.max(5, Math.min(100, 100 - fsdPenalty)));

  let fsdGrade = 'S+ Ultra Smooth';
  let fsdRecommendation = 'Top-tier FSD corridor: ultra-low vertical G, smooth longitudinal control, minimal body fatigue.';
  if (fsdComfortScore < 45) {
    fsdGrade = 'F Severe G Hazards';
    fsdRecommendation = 'High G-force route with severe potholes or abrupt braking zones. Avoid on FSD; reroute to smoother corridor.';
  } else if (fsdComfortScore < 62) {
    fsdGrade = 'D Rough / High Wear';
    fsdRecommendation = 'Significant vertical shock & cabin jerk detected. High body wear on stiffer suspensions.';
  } else if (fsdComfortScore < 76) {
    fsdGrade = 'C Moderate Roughness';
    fsdRecommendation = 'Acceptable for FSD in Chill mode, but contains localized road bumps or sharp lateral curves.';
  } else if (fsdComfortScore < 88) {
    fsdGrade = 'B Smooth FSD Route';
    fsdRecommendation = 'Good FSD route with gentle curvature and low cumulative spine wear.';
  } else if (fsdComfortScore < 94) {
    fsdGrade = 'A FSD Ideal';
    fsdRecommendation = 'Excellent smooth pavement and predictable geometry; highly recommended for Tesla FSD.';
  }

  const iriEstimate = normalizedGToIri(normalizedRoadRoughnessG);

  return {
    sampleCount: n,
    durationSec: Number(totalDtSec.toFixed(1)),
    distanceMiles: Number(distanceMiles.toFixed(2)),
    peakGLon: Number(peakGLon.toFixed(3)),
    peakGLat: Number(peakGLat.toFixed(3)),
    peakGVert: Number(peakGVert.toFixed(3)),
    peakGTotal: Number(peakGTotal.toFixed(3)),
    avgDynamicG: Number(avgDynamicG.toFixed(3)),
    rmsGVert: Number(rmsGVert.toFixed(3)),
    rmsGTotal: Number(rmsGTotal.toFixed(3)),
    normalizedRoadRoughnessG: Number(normalizedRoadRoughnessG.toFixed(3)),
    estimatedIriInchesPerMile: iriEstimate.iriInchesPerMile,
    estimatedIriMetersPerKm: iriEstimate.iriMetersPerKm,
    fhwaRating: iriEstimate.fhwaRating,
    peakJerkGPerSec: Number(peakJerk.toFixed(2)),
    avgJerkGPerSec: Number(avgJerkGPerSec.toFixed(2)),
    isoWeightedRmsMps2: Number(isoWeightedRmsMps2.toFixed(3)),
    vibrationDoseValueVdv: Number(vibrationDoseValueVdv.toFixed(3)),
    spineMicroShocksCount,
    severeShockCount,
    hardBrakeCount,
    bodyWearScore,
    bodyWearGrade,
    smoothnessScore,
    fsdComfortScore,
    fsdGrade,
    fsdRecommendation,
    vehicleTransferFactor: transfer.verticalFactor
  };
}

/**
 * Predict how a public route (with baseline normalized road metrics) will feel
 * in a specific user's car based on its suspension & tire profile.
 */
function predictRouteForVehicle(route, vehicle = {}) {
  const transfer = computeVehicleTransferFactor(vehicle);
  const kVert = transfer.verticalFactor;
  const kLat = transfer.lateralFactor;

  const baseRmsVert = Number(route.normalizedRoadRoughnessG || route.avgVerticalG || 0.08);
  const basePeakVert = Number(route.peakVerticalG || route.peakG || 0.25);
  const basePeakLat = Number(route.peakLateralG || 0.20);
  const baseBodyWear = Number(route.bodyWearScore || 20);
  const baseSmoothness = Number(route.smoothnessScore || 85);
  const baseFsdScore = Number(route.fsdComfortScore || 85);

  const predictedRmsVertG = Number((baseRmsVert * kVert).toFixed(3));
  const predictedPeakVertG = Number((basePeakVert * kVert).toFixed(2));
  const predictedPeakLatG = Number((basePeakLat * kLat).toFixed(2));

  // Stiffer cars (kVert > 1) increase body wear and reduce perceived smoothness on rough roads
  const wearMultiplier = Math.pow(kVert, 1.45);
  const predictedBodyWearScore = Math.round(Math.max(2, Math.min(100, baseBodyWear * wearMultiplier)));

  const roughnessDelta = (100 - baseSmoothness) * (kVert - 1.0) * 1.15;
  const predictedSmoothnessScore = Math.round(Math.max(5, Math.min(100, baseSmoothness - roughnessDelta)));
  const predictedFsdScore = Math.round(Math.max(5, Math.min(100, baseFsdScore - roughnessDelta * 0.9)));

  const iriEstimate = normalizedGToIri(baseRmsVert);

  return {
    vehicleName: vehicle.make ? `${vehicle.year || ''} ${vehicle.make} ${vehicle.model}`.trim() : 'Standard Reference Car',
    suspensionDampingFactor: kVert,
    predictedRmsVertG,
    predictedPeakVertG,
    predictedPeakLatG,
    predictedBodyWearScore,
    predictedSmoothnessScore,
    predictedFsdScore,
    estimatedIriInchesPerMile: route.iriInchesPerMile || iriEstimate.iriInchesPerMile,
    estimatedIriMetersPerKm: iriEstimate.iriMetersPerKm,
    fhwaRating: iriEstimate.fhwaRating,
    comfortDeltaVsBaseline: Math.round(predictedSmoothnessScore - baseSmoothness)
  };
}

/**
 * Automatically scan telemetry points for localized high-G road hazards.
 */
function detectGForceHazards(rawSamples = [], vehicle = {}) {
  const samples = sanitizeAndDetrendSamples(rawSamples);
  const hasRealGpsSpeed = samples.some((s) => (Number(s.speedMph) || 0) >= 8);
  const hazards = [];
  const transfer = computeVehicleTransferFactor(vehicle);
  let lastHazardIdx = -10;

  for (let i = 1; i < samples.length; i++) {
    if (i - lastHazardIdx < 5) continue; // Debounce adjacent samples

    const s = samples[i];
    if (hasRealGpsSpeed && (Number(s.speedMph) || 0) < 5) continue;
    const prev = samples[i - 1];
    const gLon = Number(s.gLon) || 0;
    const gLat = Number(s.gLat) || 0;
    const gVert = Number(s.gVert) || 0;
    const absVert = Math.abs(gVert);
    const absLat = Math.abs(gLat);
    const gTotal = Math.hypot(gLon, gLat, gVert);

    const dt = Math.max(0.08, Math.min(0.5, ((Number(s.timestampMs) || 100) - (Number(prev.timestampMs) || 0)) / 1000 || 0.1));
    const vertJerk = Math.abs(gVert - (Number(prev.gVert) || 0)) / dt;

    let hazardType = null;
    let severity = 'moderate';
    let label = '';
    let description = '';

    if (absVert >= 0.52 || (absVert >= 0.42 && vertJerk >= 2.2)) {
      hazardType = 'pothole_shock';
      severity = absVert >= 0.68 ? 'severe' : 'high';
      label = absVert >= 0.68 ? 'Severe Pothole / Crater' : 'Sharp Pothole / Sunken Cover';
      description = `Vertical G-spike of ${absVert.toFixed(2)}G (${vertJerk.toFixed(1)} G/s jerk) causes high spinal compression.`;
    } else if (absVert >= 0.34) {
      hazardType = 'expansion_joint';
      severity = 'moderate';
      label = 'Jarring Expansion Joint / Speed Hump';
      description = `Vertical jounce of ${absVert.toFixed(2)}G across roadway joint or hump.`;
    } else if (gLon <= -0.42) {
      hazardType = 'fsd_braking_zone';
      severity = gLon <= -0.58 ? 'severe' : 'high';
      label = 'Hard Braking / FSD Deceleration Zone';
      description = `Longitudinal deceleration spike of ${gLon.toFixed(2)}G; causes forward torso pitch and passenger discomfort.`;
    } else if (absLat >= 0.38) {
      hazardType = 'high_lateral_g_curve';
      severity = absLat >= 0.50 ? 'high' : 'moderate';
      label = 'High Lateral-G Curve / Abrupt Transition';
      description = `Sustained ${absLat.toFixed(2)}G lateral cornering force; induces neck and torso side-load.`;
    }

    if (hazardType && typeof s.lat === 'number' && typeof s.lng === 'number') {
      // Spatially deduplicate within 0.05 miles (~260 ft) so one intersection doesn't create multiple pins
      const isDuplicateSpot = hazards.some(
        (h) => h.type === hazardType && haversineMiles(h.lat, h.lng, s.lat, s.lng) < 0.05
      );
      if (isDuplicateSpot) continue;

      lastHazardIdx = i;
      const normalizedSeverityG = Number((gTotal / (transfer.verticalFactor || 1.0)).toFixed(3));
      hazards.push({
        type: hazardType,
        severity,
        label,
        description,
        lat: Number(s.lat.toFixed(6)),
        lng: Number(s.lng.toFixed(6)),
        peakG: Number(gTotal.toFixed(3)),
        verticalG: Number(absVert.toFixed(3)),
        lateralG: Number(absLat.toFixed(3)),
        longitudinalG: Number(gLon.toFixed(3)),
        normalizedSeverityG,
        speedMph: Number((s.speedMph || 35).toFixed(1)),
        timestampMs: s.timestampMs || Date.now()
      });
    }
  }

  return hazards;
}

/**
 * Haversine distance between two GPS coordinates in miles.
 */
function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Score and rank candidate routes between an origin & destination based on the user's
 * selected optimization mode ('fsd_smooth', 'low_body_wear', 'balanced', 'fastest')
 * and their active vehicle profile.
 */
function rankRoutesForDriver(routes = [], mode = 'fsd_smooth', vehicle = {}) {
  const enriched = routes.map((route) => {
    const vehiclePrediction = predictRouteForDriver(route, vehicle);
    const durationMin = Number(route.estimatedMinutes || 20);
    const fsdScore = vehiclePrediction.predictedFsdScore;
    const smoothness = vehiclePrediction.predictedSmoothnessScore;
    const bodyWear = vehiclePrediction.predictedBodyWearScore;

    // Composite optimization score (0-100, higher is better for selected preference)
    let compositeRankScore = 0;
    if (mode === 'fsd_smooth') {
      compositeRankScore = fsdScore * 0.55 + smoothness * 0.30 + (100 - bodyWear) * 0.10 - durationMin * 0.25;
    } else if (mode === 'low_body_wear') {
      compositeRankScore = (100 - bodyWear) * 0.60 + smoothness * 0.30 + fsdScore * 0.10 - durationMin * 0.15;
    } else if (mode === 'fastest') {
      compositeRankScore = 100 - durationMin * 1.8 + smoothness * 0.15;
    } else {
      // balanced
      compositeRankScore = smoothness * 0.35 + fsdScore * 0.30 + (100 - bodyWear) * 0.20 - durationMin * 0.65;
    }

    return {
      ...route,
      vehiclePrediction,
      compositeRankScore: Number(compositeRankScore.toFixed(1))
    };
  });

  enriched.sort((a, b) => b.compositeRankScore - a.compositeRankScore);

  if (enriched.length > 0) {
    const fastestMin = Math.min(...enriched.map((r) => Number(r.estimatedMinutes || 20)));
    const maxBodyWear = Math.max(...enriched.map((r) => r.vehiclePrediction.predictedBodyWearScore));

    enriched.forEach((r, idx) => {
      r.isRecommended = idx === 0;
      r.timeDeltaMinutes = Number((Number(r.estimatedMinutes || 20) - fastestMin).toFixed(1));
      r.bodyWearReductionPct = maxBodyWear > 0
        ? Math.round(((maxBodyWear - r.vehiclePrediction.predictedBodyWearScore) / maxBodyWear) * 100)
        : 0;
    });
  }

  return enriched;
}

function predictRouteForDriver(route, vehicle) {
  return predictRouteForVehicle(route, vehicle);
}

module.exports = {
  G0,
  VEHICLE_TEMPLATES,
  computeVehicleTransferFactor,
  calibrateMountOrientation,
  transformPhoneToVehicleG,
  analyzeTripBiomechanics,
  predictRouteForVehicle,
  detectGForceHazards,
  rankRoutesForDriver,
  haversineMiles,
  iriToNormalizedMetrics,
  normalizedGToIri
};
