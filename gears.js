// Virtual gearing.
//
// The trainer is put into simulation mode and told a road gradient. Each gear
// up adds a fixed amount of gradient, each gear down takes it away.
//
// Gear 12 ("NEUTRAL_GEAR") feels exactly like the trainer on a flat road.
// Higher gears = harder, lower gears = easier.

// Virtual chainring/cog ratios, easiest first. 24 gears.
export const GEAR_RATIOS = [
  0.75, 0.87, 0.99, 1.11, 1.23, 1.38, 1.53, 1.68, 1.86, 2.04, 2.22, 2.40,
  2.61, 2.82, 3.03, 3.24, 3.49, 3.74, 3.99, 4.24, 4.54, 4.84, 5.14, 5.49,
];
export const NEUTRAL_GEAR = 12;
export const START_GEAR = 12;

// Road model. These are also sent to the trainer so both sides use the same model.
export const ROAD = {
  massKg: 80,     // rider + bike, as assumed by the trainer
  crr: 0.004,     // rolling resistance
  cw: 0.51,       // wind resistance coefficient, kg/m (FTMS units)
  maxGrade: 0.20, // clamp to what the trainer can reasonably do
  minGrade: -0.10,
};

// The D100 doesn't measure cadence, but with the Cog you are always in one real
// gear, so cadence is proportional to the trainer's speed. Measured on 9 Nov 2026:
// 60 rpm (counted) = 18.06 km/h on the trainer. Re-measure if you change the
// chainring you ride on the trainer.
export const CADENCE_RPM_PER_KMH = 60 / 18.06;

export function cadenceFromSpeed(trainerSpeedKmh, powerW) {
  if (!(powerW > 0)) return 0; // coasting: flywheel still spins, but you're not pedalling
  return trainerSpeedKmh * CADENCE_RPM_PER_KMH;
}

const G = 9.81;
const WHEEL_CIRCUMFERENCE_M = 2.105;

// How much faster (or slower) the virtual bike goes than the trainer's own gear.
export function gearFactor(gear) {
  return GEAR_RATIOS[gear - 1] / GEAR_RATIOS[NEUTRAL_GEAR - 1];
}

// How much gradient each gear adds or removes. 0.01 = 1% per gear.
// Gear 12 is flat, gear 24 is +12%, gear 2 is -10%. Make this bigger or
// smaller to change how strong each shift feels.
export const GRADE_PER_GEAR = 0.01;

// Gradient (as a fraction, 0.02 = 2%) to send to the trainer for this gear.
// The same at every speed, so shifts are noticeable even when riding slowly.
export function gradeForGear(gear, _trainerSpeedMs, road = ROAD) {
  const grade = (gear - NEUTRAL_GEAR) * GRADE_PER_GEAR;
  return Math.min(road.maxGrade, Math.max(road.minGrade, grade));
}

// Speed of the virtual bike, for display.
export function virtualSpeedKmh(gear, trainerSpeedMs) {
  return trainerSpeedMs * gearFactor(gear) * 3.6;
}

// If the trainer doesn't report speed, estimate it from cadence in the neutral gear.
export function speedFromCadence(cadenceRpm) {
  return (cadenceRpm / 60) * GEAR_RATIOS[NEUTRAL_GEAR - 1] * WHEEL_CIRCUMFERENCE_M;
}

// If the trainer reports neither speed nor cadence, work speed out from power:
// solve  P = (m·g·(grade + crr) + cw·v²) · v  for v, using the grade last sent.
export function speedFromPower(powerW, grade, road = ROAD) {
  if (!(powerW > 0)) return 0;
  const a = road.massKg * G * (grade + road.crr);
  let lo = 0, hi = 30; // m/s
  for (let n = 0; n < 40; n++) {
    const mid = (lo + hi) / 2;
    if ((a + road.cw * mid * mid) * mid < powerW) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// FTMS "Set Indoor Bike Simulation Parameters" (op code 0x11) command bytes.
export function simulationCommand(grade, road = ROAD) {
  const buf = new DataView(new ArrayBuffer(7));
  buf.setUint8(0, 0x11);
  buf.setInt16(1, 0, true);                              // wind speed, 0.001 m/s
  buf.setInt16(3, Math.round(grade * 10000), true);      // grade, 0.01 %
  buf.setUint8(5, Math.round(road.crr * 10000));         // crr, 0.0001
  buf.setUint8(6, Math.round(road.cw * 100));            // cw, 0.01 kg/m
  return new Uint8Array(buf.buffer);
}
