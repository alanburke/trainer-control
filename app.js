import { parseIndoorBikeData, parseCyclingPower, cadenceFromCrank, parseFeatures } from './ftms.js';
import {
  GEAR_RATIOS, START_GEAR, gradeForGear, virtualSpeedKmh,
  speedFromCadence, speedFromPower, simulationCommand, cadenceFromSpeed,
} from './gears.js';
import { connectClick } from './click.js';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), connect: $('connect'), disconnect: $('disconnect'),
  power: $('power'), cadence: $('cadence'), speed: $('speed'), grade: $('grade'),
  gear: $('gear'), gearUp: $('gear-up'), gearDown: $('gear-down'),
  testHill: $('test-hill'), copyLog: $('copy-log'),
  features: $('features'), log: $('log'),
};

// ---- State ----
let device = null;
let source = null;          // 'FTMS' or 'CPS'
let cpsActive = false;
let testHill = false;       // override gears with a steep hill, to check control works
let lastCrank = null;
let lastCadenceAt = 0;

const rider = { powerW: 0, cadenceRpm: undefined, trainerSpeedKmh: undefined };
let speedSourceLogged = false;

let controlPoint = null;
let hasControl = false;
let cpBusy = false;
let pendingResponse = null;

let gear = START_GEAR;
let gearDirty = false;      // gear changed, send right away
let lastSentGrade = null;
let lastSentAt = 0;

// ---- Helpers ----
function log(msg) {
  const t = new Date().toLocaleTimeString();
  ui.log.textContent = `${t}  ${msg}\n` + ui.log.textContent.slice(0, 8000);
  console.log(msg);
}

function setStatus(text, kind = '') {
  ui.status.textContent = text;
  ui.status.className = `status ${kind}`;
}

function hex(data) {
  const bytes = data instanceof DataView
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data;
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

// Trainer speed in m/s: reported speed, else estimated from cadence, else from power.
function trainerSpeedMs() {
  let how, v;
  if (rider.trainerSpeedKmh !== undefined) { how = 'trainer'; v = rider.trainerSpeedKmh / 3.6; }
  else if (rider.cadenceRpm !== undefined) { how = 'cadence'; v = speedFromCadence(rider.cadenceRpm); }
  else { how = 'power'; v = speedFromPower(rider.powerW, lastSentGrade ?? 0); }
  if (!speedSourceLogged && rider.powerW > 0) {
    log(`Speed is coming from: ${how}`);
    speedSourceLogged = true;
  }
  return v;
}

// ---- Display ----
function show({ powerW, cadenceRpm, speedKmh }) {
  if (powerW !== undefined) { rider.powerW = powerW; ui.power.textContent = Math.max(0, powerW); }
  if (cadenceRpm !== undefined) {
    rider.cadenceRpm = cadenceRpm;
    ui.cadence.textContent = Math.round(cadenceRpm);
    lastCadenceAt = Date.now();
  }
  if (speedKmh !== undefined) {
    rider.trainerSpeedKmh = speedKmh;
    // No measured cadence from the trainer: estimate it from speed (see gears.js).
    if (rider.cadenceRpm === undefined) {
      ui.cadence.textContent = Math.round(cadenceFromSpeed(speedKmh, rider.powerW));
    }
  }
  ui.speed.textContent = virtualSpeedKmh(gear, trainerSpeedMs()).toFixed(1);
}

function showGear() {
  ui.gear.textContent = gear;
  ui.gearDown.disabled = !hasControl || gear <= 1;
  ui.gearUp.disabled = !hasControl || gear >= GEAR_RATIOS.length;
  ui.testHill.disabled = !hasControl;
}

// Cycling Power cadence only updates on crank events, so show 0 once pedalling stops.
setInterval(() => {
  if (device && cpsActive && lastCrank && Date.now() - lastCadenceAt > 3000) {
    ui.cadence.textContent = '0';
  }
}, 1000);

// ---- Trainer control point ----

// Writes one command and waits for the trainer's reply. Returns true on success.
function cpWrite(bytes) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log(`No reply to command ${hex(bytes)}`);
      pendingResponse = null;
      resolve(false);
    }, 3000);
    pendingResponse = {
      opcode: bytes[0],
      done: (ok) => { clearTimeout(timer); pendingResponse = null; resolve(ok); },
    };
    controlPoint.writeValueWithResponse(bytes).catch((err) => {
      log(`Write failed: ${err.message}`);
      pendingResponse?.done(false);
    });
  });
}

function onControlPointReply(e) {
  const v = e.target.value;
  if (v.getUint8(0) !== 0x80) return;
  const opcode = v.getUint8(1);
  const result = v.getUint8(2);
  const results = { 1: 'ok', 2: 'not supported', 3: 'invalid parameter', 4: 'failed', 5: 'control not permitted' };
  if (result !== 1 || opcode !== 0x11) log(`Trainer reply to 0x${opcode.toString(16)}: ${results[result] ?? result}`);
  if (pendingResponse && pendingResponse.opcode === opcode) pendingResponse.done(result === 1);
}

async function takeControl(service) {
  controlPoint = await service.getCharacteristic('fitness_machine_control_point');
  controlPoint.addEventListener('characteristicvaluechanged', onControlPointReply);
  await controlPoint.startNotifications();

  // The trainer reports its own state changes here (e.g. "control lost", "new gradient").
  try {
    const status = await service.getCharacteristic('fitness_machine_status');
    status.addEventListener('characteristicvaluechanged', (e) => log(`Trainer status: ${hex(e.target.value)}`));
    await status.startNotifications();
  } catch (err) {
    log(`No trainer status feed: ${err.message}`);
  }

  if (!await cpWrite(new Uint8Array([0x00]))) {
    log('Trainer refused control. Is another app (e.g. Zwift) connected to it?');
    return;
  }
  await cpWrite(new Uint8Array([0x07])); // start / resume
  hasControl = true;
  gearDirty = true;
  log('Got control of the trainer');
  showGear();
}

// Sends the gradient for the current gear. Runs often but only writes when needed:
// straight away after a gear change, otherwise at most once a second if it changed.
async function updateResistance() {
  if (!hasControl || cpBusy) return;
  const grade = testHill ? TEST_HILL_GRADE : gradeForGear(gear, trainerSpeedMs());
  const now = Date.now();
  const changed = lastSentGrade === null || Math.abs(grade - lastSentGrade) >= 0.001;
  if (!gearDirty && !(changed && now - lastSentAt >= 1000)) return;

  const announce = gearDirty;
  gearDirty = false;
  cpBusy = true;
  const cmd = simulationCommand(grade);
  const ok = await cpWrite(cmd);
  cpBusy = false;
  lastSentAt = Date.now();
  if (announce || !ok) {
    log(`${testHill ? 'Test hill' : `Gear ${gear}`}: sent ${(grade * 100).toFixed(2)}% [${hex(cmd)}] → ${ok ? 'accepted' : 'NOT accepted'}`);
  }
  if (ok) {
    lastSentGrade = grade;
    ui.grade.textContent = (grade * 100).toFixed(1);
  }
}
setInterval(updateResistance, 200);

const TEST_HILL_GRADE = 0.10;

function toggleTestHill() {
  testHill = !testHill;
  ui.testHill.textContent = testHill ? 'Stop test hill' : 'Test: 10% hill';
  ui.testHill.classList.toggle('active', testHill);
  gearDirty = true;
  updateResistance();
}

function shift(delta) {
  if (!hasControl) return;
  const next = Math.min(GEAR_RATIOS.length, Math.max(1, gear + delta));
  if (next === gear) return;
  gear = next;
  gearDirty = true;
  showGear();
  updateResistance();
}

// ---- Keep the phone screen on while riding ----
let wakeLock = null;
async function keepScreenOn() {
  try {
    if (!('wakeLock' in navigator) || wakeLock) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    log('Screen will stay on');
  } catch (err) {
    log(`Could not keep screen on: ${err.message}`);
  }
}
// The lock is dropped when the page is hidden; take it again on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && device?.gatt.connected) keepScreenOn();
});

// ---- Connecting ----
async function connect() {
  try {
    setStatus('Choose your trainer in the Bluetooth popup…');
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ['fitness_machine'] }, { services: ['cycling_power'] }],
      optionalServices: ['fitness_machine', 'cycling_power', 'device_information'],
    });
    device.addEventListener('gattserverdisconnected', onDisconnected);

    setStatus(`Connecting to ${device.name || 'trainer'}…`);
    const server = await device.gatt.connect();
    log(`Connected to "${device.name}"`);

    const services = await server.getPrimaryServices();
    log('Services: ' + services.map((s) => s.uuid.slice(4, 8)).join(', '));

    const ftms = services.find((s) => s.uuid.startsWith('00001826'));
    const cps = services.find((s) => s.uuid.startsWith('00001818'));

    if (ftms) {
      await startFtms(ftms);
      // Some trainers only send power/cadence on the Cycling Power service, so listen there too.
      if (cps) {
        try { await startCps(cps); } catch (err) { log(`Cycling Power not readable: ${err.message}`); }
      }
      await takeControl(ftms);
    } else if (cps) {
      await startCps(cps);
      ui.features.textContent = 'This trainer has no FTMS service, so it may not accept resistance control over Bluetooth.';
    } else {
      throw new Error('Trainer has neither FTMS nor Cycling Power service');
    }

    setStatus(`Connected: ${device.name}${hasControl ? '' : ' (read only)'}`, 'ok');
    keepScreenOn();
    ui.connect.disabled = true;
    ui.disconnect.disabled = false;
  } catch (err) {
    log(`Error: ${err.message}`);
    setStatus(err.name === 'NotFoundError' ? 'No device chosen' : `Error: ${err.message}`, 'err');
  }
}

async function startFtms(service) {
  source = 'FTMS';
  try {
    const raw = await (await service.getCharacteristic('fitness_machine_feature')).readValue();
    log(`FTMS features raw: ${hex(raw)}`);
    const f = parseFeatures(raw);
    ui.features.textContent =
      `Virtual gears (simulation mode): ${f.supportsSimulation ? 'SUPPORTED ✅' : 'not listed ⚠️'}\n\n` +
      `Measures:\n  ${f.measures.join('\n  ') || '(none listed)'}\n\n` +
      `Can be controlled by:\n  ${f.controls.join('\n  ') || '(none listed)'}`;
  } catch (err) {
    log(`Could not read features: ${err.message}`);
  }

  const bikeData = await service.getCharacteristic('indoor_bike_data');
  let logged = 0;
  bikeData.addEventListener('characteristicvaluechanged', (e) => {
    const v = e.target.value;
    const parsed = parseIndoorBikeData(v);
    show(parsed);
    // Log the first few packets in full, then every 20th, to keep the log readable.
    if (logged++ < 5 || logged % 20 === 0) log(`bike data ${hex(v)} → ${JSON.stringify(parsed)}`);
  });
  await bikeData.startNotifications();
  log('Listening for Indoor Bike Data');
}

async function startCps(service) {
  source ??= 'CPS';
  cpsActive = true;
  const measurement = await service.getCharacteristic('cycling_power_measurement');
  let logged = 0;
  measurement.addEventListener('characteristicvaluechanged', (e) => {
    const v = e.target.value;
    const parsed = parseCyclingPower(v);
    const cadence = cadenceFromCrank(lastCrank, parsed);
    if (parsed.crankRevs !== undefined) lastCrank = parsed;
    show({ powerW: parsed.powerW, cadenceRpm: cadence });
    if (logged++ < 5 || logged % 20 === 0) log(`power data ${hex(v)} → ${JSON.stringify(parsed)}`);
  });
  await measurement.startNotifications();
  log('Listening for Cycling Power');
}

function onDisconnected() {
  log('Trainer disconnected');
  setStatus('Disconnected', 'err');
  ui.connect.disabled = false;
  ui.disconnect.disabled = true;
  for (const el of [ui.power, ui.cadence, ui.speed, ui.grade]) el.textContent = '--';
  lastCrank = null;
  source = null;
  cpsActive = false;
  if (testHill) toggleTestHill();
  controlPoint = null;
  hasControl = false;
  cpBusy = false;
  lastSentGrade = null;
  speedSourceLogged = false;
  Object.assign(rider, { powerW: 0, cadenceRpm: undefined, trainerSpeedKmh: undefined });
  showGear();
}

// ---- Inputs ----
ui.connect.addEventListener('click', connect);
ui.disconnect.addEventListener('click', () => device?.gatt.connected && device.gatt.disconnect());
ui.gearUp.addEventListener('click', () => shift(+1));
ui.gearDown.addEventListener('click', () => shift(-1));
ui.testHill.addEventListener('click', toggleTestHill);

// ---- Zwift Click ----
const clickUi = { button: $('connect-click'), status: $('click-status') };
function setClickStatus(text, kind = '') {
  clickUi.status.textContent = text;
  clickUi.status.className = `status ${kind}`;
}
clickUi.button.addEventListener('click', async () => {
  try {
    setClickStatus('Click: choose it in the popup…');
    const clickDevice = await connectClick({
      log,
      onShift: (delta) => {
        log(`Click: ${delta > 0 ? '+' : '−'} pressed`);
        if (!hasControl) log('Click: connect the trainer first, then shifts will work');
        shift(delta);
      },
      onBattery: (pct) => setClickStatus(`Click: connected · battery ${pct}%`, 'ok'),
      onDisconnect: () => {
        log('Click disconnected');
        setClickStatus('Click: disconnected', 'err');
        clickUi.button.disabled = false;
      },
    });
    setClickStatus(`Click: connected (${clickDevice.name})`, 'ok');
    clickUi.button.disabled = true;
  } catch (err) {
    log(`Click error: ${err.message}`);
    setClickStatus(err.name === 'NotFoundError' ? 'Click: none chosen' : 'Click: error (see log)', 'err');
  }
});
ui.copyLog.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(ui.log.textContent);
    ui.copyLog.textContent = 'Copied ✓';
  } catch {
    ui.copyLog.textContent = 'Copy failed: select the text instead';
  }
  setTimeout(() => { ui.copyLog.textContent = 'Copy log'; }, 2000);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); shift(+1); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); shift(-1); }
});

showGear();
if (!navigator.bluetooth) {
  $('no-bluetooth').hidden = false;
  ui.connect.disabled = true;
}
