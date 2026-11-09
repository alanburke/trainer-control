// Parsers for the Bluetooth fitness protocols that smart trainers use.
// FTMS = Fitness Machine Service (0x1826). CPS = Cycling Power Service (0x1818).

// Parses one notification from the FTMS Indoor Bike Data characteristic (0x2AD2).
// Fields that are absent from this packet are left undefined: some trainers
// split their data over several notifications.
export function parseIndoorBikeData(dataView) {
  const flags = dataView.getUint16(0, true);
  let i = 2;
  const out = {};

  // Bit 0 is inverted: 0 means Instantaneous Speed IS present.
  if ((flags & 0x0001) === 0) { out.speedKmh = dataView.getUint16(i, true) / 100; i += 2; }
  if (flags & 0x0002) { i += 2; }                                  // average speed
  if (flags & 0x0004) { out.cadenceRpm = dataView.getUint16(i, true) / 2; i += 2; }
  if (flags & 0x0008) { i += 2; }                                  // average cadence
  if (flags & 0x0010) { i += 3; }                                  // total distance (uint24)
  if (flags & 0x0020) { out.resistanceLevel = dataView.getInt16(i, true); i += 2; }
  if (flags & 0x0040) { out.powerW = dataView.getInt16(i, true); i += 2; }
  if (flags & 0x0080) { i += 2; }                                  // average power
  if (flags & 0x0100) { i += 5; }                                  // expended energy
  if (flags & 0x0200) { out.heartRate = dataView.getUint8(i); i += 1; }

  return out;
}

// Parses a Cycling Power Measurement (0x2A63) notification.
// Returns power and, if present, raw crank revolution data for cadence.
export function parseCyclingPower(dataView) {
  const flags = dataView.getUint16(0, true);
  let i = 2;
  const out = { powerW: dataView.getInt16(i, true) };
  i += 2;

  if (flags & 0x0001) { i += 1; }  // pedal power balance
  if (flags & 0x0004) { i += 2; }  // accumulated torque
  if (flags & 0x0010) { i += 6; }  // wheel revolution data
  if (flags & 0x0020) {
    out.crankRevs = dataView.getUint16(i, true);
    out.crankTime = dataView.getUint16(i + 2, true); // units of 1/1024 s
  }
  return out;
}

// Works out cadence from two consecutive crank readings (both wrap at 65536).
export function cadenceFromCrank(prev, curr) {
  if (!prev || curr.crankRevs === undefined) return undefined;
  const revs = (curr.crankRevs - prev.crankRevs + 65536) % 65536;
  const ticks = (curr.crankTime - prev.crankTime + 65536) % 65536;
  if (ticks === 0) return undefined; // no new crank event since last packet
  return (revs / (ticks / 1024)) * 60;
}

// Decodes the Fitness Machine Feature characteristic (0x2ACC) into readable lists.
export function parseFeatures(dataView) {
  const machine = dataView.getUint32(0, true);
  const target = dataView.getUint32(4, true);

  const machineNames = [
    'Average speed', 'Cadence', 'Total distance', 'Inclination', 'Elevation gain',
    'Pace', 'Step count', 'Resistance level', 'Stride count', 'Expended energy',
    'Heart rate', 'Metabolic equivalent', 'Elapsed time', 'Remaining time',
    'Power measurement', 'Force on belt / power output', 'User data retention',
  ];
  const targetNames = [
    'Target speed', 'Target inclination', 'Target resistance level', 'Target power (ERG)',
    'Target heart rate', 'Targeted expended energy', 'Targeted step number',
    'Targeted stride number', 'Targeted distance', 'Targeted training time',
    'Targeted time in two HR zones', 'Targeted time in three HR zones',
    'Targeted time in five HR zones', 'Indoor bike simulation (gradient)',
    'Wheel circumference', 'Spin down control', 'Targeted cadence',
  ];

  const pick = (bits, names) => names.filter((_, n) => bits & (1 << n));
  return {
    measures: pick(machine, machineNames),
    controls: pick(target, targetNames),
    supportsSimulation: Boolean(target & (1 << 13)),
  };
}
