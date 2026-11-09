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
