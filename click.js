// Zwift Click controller (v1 and v2) over Web Bluetooth.
//
// Zwift doesn't publish this protocol. These details come from the open-source
// BikeControl (github.com/OpenBikeControl/bikecontrol) and zwiftplay
// (github.com/ajchellew/zwiftplay) projects, which reverse-engineered it.
//
// Note: a Click v2 only exposes its controller service if it was connected to
// the Zwift app in the last 24 hours. Otherwise the service is hidden.

export const ZWIFT_COMPANY_ID = 0x094a;
export const SERVICE_V1 = '00000001-19ca-4651-86e5-fa29dcdd09d1'; // Click v1, Play
export const SERVICE_V2 = '0000fc82-0000-1000-8000-00805f9b34fb'; // Click v2, Ride
const ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1';   // button notifications
const SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1'; // we write commands here
const SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1'; // device replies here

const RIDE_ON = new TextEncoder().encode('RideOn');

// Message types (first byte of each notification).
export const MSG = {
  CLICK_V1_BUTTONS: 0x37,
  RIDE_BUTTONS: 0x23,  // Click v2 and Ride
  BATTERY: 0x19,
  IDLE: 0x15,          // sent when nothing is happening
  CLICK_V2_UNKNOWN: 0x3c,
};

// Click v2 / Ride button bits. A bit set to 0 means the button is PRESSED.
const RIDE_MASK = { SHIFT_UP_LEFT: 0x0100, SHIFT_DOWN_LEFT: 0x0200, SHIFT_UP_RIGHT: 0x1000, SHIFT_DOWN_RIGHT: 0x2000 };

// Minimal protobuf reader: returns { fieldNumber: firstVarintValue }.
// Uses plain arithmetic rather than bitwise ops, because values can exceed 32 bits.
export function readProtobufVarints(bytes) {
  const fields = {};
  let i = 0;
  const varint = () => {
    let value = 0, scale = 1, b;
    do {
      b = bytes[i++];
      value += (b & 0x7f) * scale;
      scale *= 128;
    } while (b & 0x80 && i < bytes.length);
    return value;
  };
  while (i < bytes.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) { const v = varint(); if (!(field in fields)) fields[field] = v; }
    else if (wire === 2) { const len = varint(); i += len; }
    else if (wire === 1) { i += 8; }
    else if (wire === 5) { i += 4; }
    else break; // unknown wire type: stop rather than misread
  }
  return fields;
}

const bit = (value, mask) => Math.floor(value / mask) % 2;

// Turns one notification into { plus, minus } (true = currently pressed),
// { battery }, or null for messages we don't care about.
export function parseClickMessage(bytes) {
  if (bytes.length === 0) return null;
  const type = bytes[0];
  const body = bytes.subarray(1);

  if (type === MSG.CLICK_V1_BUTTONS) {
    // Field 1 = plus, field 2 = minus. 0 = pressed, 1 = released.
    const f = readProtobufVarints(body);
    return { plus: f[1] === 0, minus: f[2] === 0 };
  }
  if (type === MSG.RIDE_BUTTONS) {
    const f = readProtobufVarints(body);
    if (f[1] === undefined) return null;
    const map = f[1];
    const pressed = (mask) => bit(map, mask) === 0;
    return {
      plus: pressed(RIDE_MASK.SHIFT_UP_RIGHT) || pressed(RIDE_MASK.SHIFT_DOWN_RIGHT),
      minus: pressed(RIDE_MASK.SHIFT_UP_LEFT) || pressed(RIDE_MASK.SHIFT_DOWN_LEFT),
    };
  }
  if (type === MSG.BATTERY) {
    // Protobuf, e.g. "19 10 1f" = field 2 → 31%.
    const f = readProtobufVarints(body);
    const level = f[2] ?? f[1];
    return level === undefined ? null : { battery: level };
  }
  return null;
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// Connects to a Click and calls onShift(+1 / -1) on each button press.
// Returns the BluetoothDevice.
export async function connectClick({ onShift, onBattery, onDisconnect, log }) {
  const basicFilters = [{ services: [SERVICE_V1] }, { services: [SERVICE_V2] }, { namePrefix: 'Zwift' }];
  const optionalServices = [SERVICE_V1, SERVICE_V2, 'battery_service'];
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ manufacturerData: [{ companyIdentifier: ZWIFT_COMPANY_ID }] }, ...basicFilters],
      optionalServices,
    });
  } catch (err) {
    // Some browsers (possibly Bluefy) don't support manufacturer filters: retry without.
    if (err.name !== 'TypeError') throw err;
    log('Click: manufacturer filter not supported here, retrying without it');
    device = await navigator.bluetooth.requestDevice({ filters: basicFilters, optionalServices });
  }
  device.addEventListener('gattserverdisconnected', () => onDisconnect?.());

  log(`Click: connecting to "${device.name}"`);
  const server = await device.gatt.connect();
  const services = await server.getPrimaryServices();
  log('Click services: ' + services.map((s) => s.uuid).join(', '));

  const service = services.find((s) => s.uuid === SERVICE_V2) || services.find((s) => s.uuid === SERVICE_V1);
  if (!service) {
    throw new Error('Click is locked. Connect it in the Zwift app once (it stays unlocked for 24 hours), close Zwift, then try again.');
  }
  const isV2 = service.uuid === SERVICE_V2;
  log(`Click: using ${isV2 ? 'v2' : 'v1'} service`);

  const asyncChar = await service.getCharacteristic(ASYNC);
  const syncTx = await service.getCharacteristic(SYNC_TX);
  const syncRx = await service.getCharacteristic(SYNC_RX);

  let last = { plus: false, minus: false };
  let lastRaw = '';
  const handle = (e) => {
    const bytes = new Uint8Array(e.target.value.buffer, e.target.value.byteOffset, e.target.value.byteLength);
    const type = bytes[0];
    // Log new messages (not repeats, not the idle heartbeat) so unknown formats still show up.
    const raw = hex(bytes);
    if (type !== MSG.IDLE && raw !== lastRaw) log(`Click raw [${e.target.uuid.slice(4, 8)}]: ${raw}`);
    lastRaw = raw;

    const msg = parseClickMessage(bytes);
    if (!msg) return;
    if (msg.battery !== undefined) { onBattery?.(msg.battery); return; }
    // Shift only when a button goes from released to pressed.
    if (msg.plus && !last.plus) onShift(+1);
    if (msg.minus && !last.minus) onShift(-1);
    last = msg;
  };

  asyncChar.addEventListener('characteristicvaluechanged', handle);
  syncTx.addEventListener('characteristicvaluechanged', handle);
  await asyncChar.startNotifications();
  await syncTx.startNotifications();

  // Handshake: plain "RideOn" asks for unencrypted messages.
  const write = (bytes) => (syncRx.writeValueWithoutResponse
    ? syncRx.writeValueWithoutResponse(bytes)
    : syncRx.writeValue(bytes));
  await write(RIDE_ON);
  log('Click: sent RideOn handshake');
  if (isV2) {
    await write(new Uint8Array([0xff, 0x04, 0x00])); // BikeControl sends this to Click v2 after the handshake
    log('Click: sent v2 follow-up (ff 04 00)');
  }

  return device;
}
