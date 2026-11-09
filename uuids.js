// Standard Bluetooth service and characteristic IDs, written out in full.
// Chrome also accepts short names like 'fitness_machine', but Bluefy (iPhone) doesn't.
const full = (short) => `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export const BT = {
  FITNESS_MACHINE: full(0x1826),
  CYCLING_POWER: full(0x1818),
  DEVICE_INFO: full(0x180a),
  BATTERY: full(0x180f),

  MACHINE_FEATURE: full(0x2acc),
  INDOOR_BIKE_DATA: full(0x2ad2),
  CONTROL_POINT: full(0x2ad9),
  MACHINE_STATUS: full(0x2ada),
  POWER_MEASUREMENT: full(0x2a63),
};

// Browsers report IDs differently: Chrome gives full lowercase
// ("00001826-0000-1000-8000-00805f9b34fb"), Bluefy may give short or uppercase
// ("1826", "0000FFC0-..."). Convert everything to full lowercase before comparing.
export function normalizeUuid(uuid) {
  const u = String(uuid).toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(u)) return `0000${u}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{8}$/.test(u)) return `${u}-0000-1000-8000-00805f9b34fb`;
  return u;
}

export const sameUuid = (a, b) => normalizeUuid(a) === normalizeUuid(b);
