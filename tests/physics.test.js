const test = require('node:test');
const assert = require('node:assert/strict');

const {
  G0,
  VEHICLE_TEMPLATES,
  computeVehicleTransferFactor,
  calibrateMountOrientation,
  transformPhoneToVehicleG,
  analyzeTripBiomechanics,
  predictRouteForVehicle,
  detectGForceHazards,
  rankRoutesForDriver,
  iriToNormalizedMetrics,
  normalizedGToIri
} = require('../src/physics/gforceEngine');

test('Phone 3-Axis Mount Calibration & Vehicle Frame Transformation', () => {
  // Phone mounted at ~60 deg angle
  const stationarySamples = [
    { ax: 0.0, ay: 8.4928, az: 4.9033 },
    { ax: 0.0, ay: 8.4928, az: 4.9033 }
  ];
  const cal = calibrateMountOrientation(stationarySamples);
  assert.ok(Math.abs(cal.gravityBaseline.magnitude - G0) < 0.02);

  // At rest, dynamic vehicle G should be 0 on all 3 axes
  const restG = transformPhoneToVehicleG({ ax: 0.0, ay: 8.4928, az: 4.9033 }, cal);
  assert.equal(restG.gVert, 0);
  assert.equal(restG.gLon, 0);
  assert.equal(restG.gLat, 0);

  // Apply +0.5G impulse along vertical gravity axis
  const bumpSample = {
    ax: 0.0,
    ay: 8.4928 * 1.5,
    az: 4.9033 * 1.5
  };
  const bumpG = transformPhoneToVehicleG(bumpSample, cal);
  assert.ok(Math.abs(bumpG.gVert - 0.5) < 0.01, `Expected ~0.5G vertical, got ${bumpG.gVert}`);
});

test('Vehicle Suspension Transfer Factor differentiates Air Suspension vs Stiff Sport Coilovers', () => {
  const modelSAir = VEHICLE_TEMPLATES.find((t) => t.id === 'tesla-model-s-lr');
  const model3Perf = VEHICLE_TEMPLATES.find((t) => t.id === 'tesla-model-3-perf');

  const tfAir = computeVehicleTransferFactor(modelSAir);
  const tfPerf = computeVehicleTransferFactor(model3Perf);

  assert.ok(tfAir.verticalFactor < 0.85, 'Model S Air should isolate vertical G (<0.85x)');
  assert.ok(tfPerf.verticalFactor > 1.15, 'Model 3 Performance 20" should transmit higher vertical G (>1.15x)');

  const sampleRoad = {
    normalizedRoadRoughnessG: 0.14,
    peakVerticalG: 0.55,
    peakLateralG: 0.25,
    bodyWearScore: 48,
    smoothnessScore: 68,
    fsdComfortScore: 70
  };

  const predAir = predictRouteForVehicle(sampleRoad, modelSAir);
  const predPerf = predictRouteForVehicle(sampleRoad, model3Perf);

  assert.ok(predAir.predictedPeakVertG < predPerf.predictedPeakVertG);
  assert.ok(predAir.predictedBodyWearScore < predPerf.predictedBodyWearScore);
  assert.ok(predAir.predictedSmoothnessScore > predPerf.predictedSmoothnessScore);
});

test('Biomechanical Body Wear (ISO 2631-1 VDV) & Tesla FSD Smoothness Score calculation', () => {
  const t0 = Date.now();
  const smoothSamples = Array.from({ length: 40 }, (_, i) => ({
    timestampMs: t0 + i * 100,
    lat: 37.60 - i * 0.0004,
    lng: -122.40 + i * 0.0004,
    gLon: 0.03 * Math.sin(i * 0.2),
    gLat: 0.04 * Math.cos(i * 0.2),
    gVert: 0.035 * Math.sin(i * 0.5),
    speedMph: 65
  }));

  const roughSamples = Array.from({ length: 40 }, (_, i) => ({
    timestampMs: t0 + i * 100,
    lat: 37.60 - i * 0.0004,
    lng: -122.40 + i * 0.0004,
    gLon: i === 20 ? -0.52 : 0.08 * Math.sin(i * 0.4),
    gLat: i === 30 ? 0.45 : 0.12 * Math.cos(i * 0.4),
    gVert: i % 8 === 0 ? 0.68 : 0.22 * Math.sin(i * 0.9),
    speedMph: 58
  }));

  const smoothAnalysis = analyzeTripBiomechanics(smoothSamples);
  const roughAnalysis = analyzeTripBiomechanics(roughSamples);

  assert.ok(smoothAnalysis.smoothnessScore >= 90, `Smooth score should be >=90, got ${smoothAnalysis.smoothnessScore}`);
  assert.ok(smoothAnalysis.fsdComfortScore >= 90);
  assert.ok(smoothAnalysis.bodyWearScore <= 15);

  assert.ok(roughAnalysis.smoothnessScore < 65, `Rough score should be <65, got ${roughAnalysis.smoothnessScore}`);
  assert.ok(roughAnalysis.bodyWearScore > smoothAnalysis.bodyWearScore);
  assert.ok(roughAnalysis.vibrationDoseValueVdv > smoothAnalysis.vibrationDoseValueVdv);
  assert.ok(roughAnalysis.spineMicroShocksCount >= 3);
  assert.ok(roughAnalysis.hardBrakeCount >= 1);

  const hazards = detectGForceHazards(roughSamples);
  assert.ok(hazards.length >= 2, 'Should automatically detect potholes and braking hazards');
});

test('FSD Smooth Route Ranking prioritizes smooth low-G routes over marginally faster rough routes', () => {
  const routes = [
    {
      id: 1,
      name: 'US-101 Rough Highway',
      estimatedMinutes: 35,
      smoothnessScore: 54,
      fsdComfortScore: 51,
      bodyWearScore: 68,
      normalizedRoadRoughnessG: 0.165,
      peakVerticalG: 0.74
    },
    {
      id: 2,
      name: 'I-280 Junipero Serra Smooth FSD Ribbon',
      estimatedMinutes: 37,
      smoothnessScore: 96,
      fsdComfortScore: 97,
      bodyWearScore: 9,
      normalizedRoadRoughnessG: 0.042,
      peakVerticalG: 0.18
    }
  ];

  const fsdRanked = rankRoutesForDriver(routes, 'fsd_smooth');
  assert.equal(fsdRanked[0].id, 2, 'FSD Smooth mode must recommend I-280 Smooth Ribbon #1');
  assert.ok(fsdRanked[0].bodyWearReductionPct > 70);

  const wearRanked = rankRoutesForDriver(routes, 'low_body_wear');
  assert.equal(wearRanked[0].id, 2, 'Low Body Wear mode must recommend I-280 Smooth Ribbon #1');
});

test('USDOT FHWA HPMS IRI <-> Normalized G conversion and RV / Motorhome / Spine-Saver profiles', () => {
  const goodIri = iriToNormalizedMetrics(58, 65);
  const poorIri = iriToNormalizedMetrics(214, 65);

  assert.equal(goodIri.fhwaRating, 'Good');
  assert.equal(poorIri.fhwaRating, 'Poor');
  assert.ok(goodIri.normalizedRoadRoughnessG < poorIri.normalizedRoadRoughnessG);
  assert.ok(goodIri.smoothnessScore > poorIri.smoothnessScore);

  const backConvert = normalizedGToIri(poorIri.normalizedRoadRoughnessG);
  assert.equal(backConvert.fhwaRating, 'Poor');
  assert.ok(backConvert.iriInchesPerMile > 170);

  // Verify RV, Sprinter, Tow-Rig, and Spine-Saver templates exist and compute accurate predictions
  const classCMotorhome = VEHICLE_TEMPLATES.find((t) => t.id === 'class-c-motorhome-e450');
  const sprinterVan = VEHICLE_TEMPLATES.find((t) => t.id === 'mercedes-sprinter-camper-2500');
  const spineSaver = VEHICLE_TEMPLATES.find((t) => t.id === 'lexus-ls500h-spine-saver');

  assert.ok(classCMotorhome && sprinterVan && spineSaver);
  assert.ok(classCMotorhome.suspensionDampingFactor > sprinterVan.suspensionDampingFactor);
  assert.ok(spineSaver.suspensionDampingFactor < 0.80);
});
