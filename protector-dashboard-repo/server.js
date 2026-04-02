const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

const PORT = Number(process.env.PORT || 3100);
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.emqx.io';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_ATTACK_TOPIC = process.env.MQTT_ATTACK_TOPIC || 'attacks/count';
const MQTT_HEARTBEAT_TOPIC = process.env.MQTT_HEARTBEAT_TOPIC || 'devices/heartbeat';
const MQTT_STATUS_TOPIC = process.env.MQTT_STATUS_TOPIC || 'devices/status';
const MQTT_CONTROL_TOPIC = process.env.MQTT_CONTROL_TOPIC || 'devices/control';
const MQTT_PROTECTION_TOPIC = process.env.MQTT_PROTECTION_TOPIC || 'protector/events';
const DEVICE_TIMEOUT_MS = Number(process.env.DEVICE_TIMEOUT_MS || 15000);
const HIGH_PRESSURE_RATE = Number(process.env.HIGH_PRESSURE_RATE || 8);
const CRITICAL_PRESSURE_RATE = Number(process.env.CRITICAL_PRESSURE_RATE || 18);
const PUBLIC_DIR = path.join(__dirname, 'public');

const protectorState = {
  totalThreatEvents: 0,
  blockedEstimate: 0,
  attackRate: 0,
  peakRate: 0,
  defenseEvents: [],
  incidents: [],
  targetPressure: new Map(),
  devices: new Map(),
  history: [],
  shieldMode: 'GUARD',
  shieldStatus: 'CALIBRATING',
  lastAction: 'MONITOR',
  lastReason: 'Waiting for live traffic telemetry',
  lastCommandAt: null,
  currentCommandSource: 'system',
  protectedAssets: 0
};

let attackTimestamps = [];
let incidentSequence = 1;
let lastBroadcastSignature = '';

const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  port: MQTT_PORT,
  keepalive: 60,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log(`Connected to MQTT broker at ${MQTT_BROKER_URL}:${MQTT_PORT}`);
  mqttClient.subscribe([
    MQTT_ATTACK_TOPIC,
    MQTT_HEARTBEAT_TOPIC,
    MQTT_STATUS_TOPIC,
    MQTT_CONTROL_TOPIC,
    MQTT_PROTECTION_TOPIC
  ]);
  console.log('Subscribed to protector dashboard topics');
});

mqttClient.on('error', (error) => {
  console.error('MQTT error:', error.message);
});

mqttClient.on('message', (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    if (topic === MQTT_ATTACK_TOPIC) {
      handleThreat(payload);
      return;
    }

    if (topic === MQTT_HEARTBEAT_TOPIC) {
      handleHeartbeat(payload);
      return;
    }

    if (topic === MQTT_STATUS_TOPIC) {
      handleStatus(payload);
      return;
    }

    if (topic === MQTT_CONTROL_TOPIC) {
      handleControl(payload);
      return;
    }

    if (topic === MQTT_PROTECTION_TOPIC) {
      handleProtectionEvent(payload);
    }
  } catch (error) {
    console.error('MQTT payload parse error:', error.message);
  }
});

function ensureDevice(deviceId, now = Date.now()) {
  if (!protectorState.devices.has(deviceId)) {
    protectorState.devices.set(deviceId, {
      id: deviceId,
      status: 'online',
      count: 0,
      attackRate: 0,
      lastSeen: now,
      lastAttack: now,
      uptime: 0,
      rssi: 0,
      target: 'Unknown',
      ip: 'N/A',
      running: true,
      pressureWindow: []
    });
    addDefenseEvent({
      kind: 'device-online',
      source: deviceId,
      title: 'Protector discovered device',
      detail: 'Telemetry channel established',
      severity: 'info',
      timestamp: now
    });
  }

  return protectorState.devices.get(deviceId);
}

function handleThreat(data) {
  const now = Date.now();
  const deviceId = data.deviceId || 'unknown-device';
  const target = data.target || 'Unknown';
  const device = ensureDevice(deviceId, now);

  protectorState.totalThreatEvents += 1;
  device.count += 1;
  device.lastSeen = now;
  device.lastAttack = now;
  device.status = 'online';
  device.target = target;
  device.type = data.type || device.type || 'HTTP_GET';

  device.pressureWindow.push(now);
  device.pressureWindow = device.pressureWindow.filter((timestamp) => now - timestamp < 1000);
  device.attackRate = device.pressureWindow.length;

  attackTimestamps.push(now);
  attackTimestamps = attackTimestamps.filter((timestamp) => now - timestamp < 1000);
  protectorState.attackRate = attackTimestamps.length;
  protectorState.peakRate = Math.max(protectorState.peakRate, protectorState.attackRate);

  const currentTargetStats = protectorState.targetPressure.get(target) || {
    target,
    hits: 0,
    lastSeen: now,
    peakRate: 0
  };

  currentTargetStats.hits += 1;
  currentTargetStats.lastSeen = now;
  currentTargetStats.peakRate = Math.max(currentTargetStats.peakRate, device.attackRate);
  protectorState.targetPressure.set(target, currentTargetStats);
  protectorState.protectedAssets = protectorState.targetPressure.size;

  protectorState.history.push({
    time: now,
    inbound: protectorState.attackRate,
    blocked: estimateBlockedTraffic(),
    exposure: getExposureScore()
  });
  if (protectorState.history.length > 120) {
    protectorState.history.shift();
  }

  evaluateShield(now, {
    reason: `Threat traffic detected from ${deviceId}`,
    source: deviceId,
    target
  });

  addDefenseEvent({
    kind: 'threat',
    source: deviceId,
    title: 'Inbound hostile traffic observed',
    detail: `${target} under pressure`,
    severity: protectorState.attackRate >= CRITICAL_PRESSURE_RATE ? 'critical' : 'warning',
    timestamp: now
  });

  broadcastUpdate();
}

function handleHeartbeat(data) {
  const now = Date.now();
  const device = ensureDevice(data.deviceId || 'unknown-device', now);
  const wasOffline = device.status === 'offline';

  device.lastSeen = now;
  device.status = 'online';
  device.count = Math.max(device.count, Number(data.attacksSent || 0));
  device.attackRate = Number(data.attackRate ?? data.rate ?? device.attackRate ?? 0);
  device.uptime = Number(data.uptime || device.uptime || 0);
  device.rssi = Number(data.rssi || device.rssi || 0);
  device.target = data.target || device.target || 'Unknown';
  device.running = data.running !== undefined ? Boolean(data.running) : device.running;

  if (wasOffline) {
    addDefenseEvent({
      kind: 'device-return',
      source: device.id,
      title: 'Device heartbeat restored',
      detail: 'Field node is back online',
      severity: 'info',
      timestamp: now
    });
  }

  evaluateShield(now, {
    reason: `Heartbeat received from ${device.id}`,
    source: device.id,
    target: device.target
  });
  broadcastUpdate();
}

function handleStatus(data) {
  const now = Date.now();
  const device = ensureDevice(data.deviceId || 'unknown-device', now);
  const wasOffline = device.status === 'offline';

  device.lastSeen = now;
  device.status = 'online';
  device.ip = data.ip || device.ip || 'N/A';
  device.attackRate = Number(data.attackRate ?? device.attackRate ?? 0);
  device.target = data.target || device.target || 'Unknown';
  device.count = Math.max(device.count, Number(data.attacksSent || 0));
  device.running = data.running !== undefined ? Boolean(data.running) : device.running;

  if (wasOffline) {
    addDefenseEvent({
      kind: 'device-return',
      source: device.id,
      title: 'Status channel restored',
      detail: 'Protector visibility re-established',
      severity: 'info',
      timestamp: now
    });
  }

  evaluateShield(now, {
    reason: `Status updated from ${device.id}`,
    source: device.id,
    target: device.target
  });
  broadcastUpdate();
}

function handleControl(data) {
  const now = Date.now();
  const action = String(data.action || 'MONITOR').toUpperCase();

  protectorState.lastAction = action;
  protectorState.lastCommandAt = now;
  protectorState.currentCommandSource = data.source || 'external-controller';
  protectorState.shieldMode = action === 'STOP' ? 'CONTAIN' : action === 'START' ? 'THROTTLE' : 'GUARD';
  protectorState.shieldStatus = action === 'STOP' ? 'LOCKDOWN' : protectorState.attackRate >= HIGH_PRESSURE_RATE ? 'ENGAGED' : 'READY';
  protectorState.lastReason = `${action} command received from ${protectorState.currentCommandSource}`;
  protectorState.blockedEstimate = estimateBlockedTraffic();

  addDefenseEvent({
    kind: 'command',
    source: protectorState.currentCommandSource,
    title: `Defense action: ${action}`,
    detail: data.target ? `Target ${data.target}` : 'Global shield instruction',
    severity: action === 'STOP' ? 'critical' : 'info',
    timestamp: now
  });

  registerIncident(action, protectorState.lastReason, now);
  broadcastUpdate();
}

function handleProtectionEvent(data) {
  const now = Date.now();
  const action = String(data.action || 'MONITOR').toUpperCase();
  protectorState.lastAction = action;
  protectorState.lastReason = data.reason || 'Protector event received';
  protectorState.shieldMode = data.mode || protectorState.shieldMode;
  protectorState.shieldStatus = data.status || protectorState.shieldStatus;
  protectorState.blockedEstimate = Number(data.blockedEstimate || protectorState.blockedEstimate || 0);

  addDefenseEvent({
    kind: 'protection-event',
    source: data.source || 'protector-feed',
    title: data.title || `Protector event: ${action}`,
    detail: protectorState.lastReason,
    severity: data.severity || 'info',
    timestamp: now
  });

  if (data.incident !== false) {
    registerIncident(action, protectorState.lastReason, now);
  }

  broadcastUpdate();
}

function evaluateShield(now, context) {
  const onlineDevices = getDevicesList().filter((device) => device.status === 'online');
  const attackRate = protectorState.attackRate;
  const exposure = getExposureScore();

  if (attackRate >= CRITICAL_PRESSURE_RATE) {
    protectorState.shieldStatus = 'LOCKDOWN';
    protectorState.shieldMode = 'CONTAIN';
    protectorState.lastReason = `${context.reason}; critical pressure on ${context.target || 'unknown target'}`;
  } else if (attackRate >= HIGH_PRESSURE_RATE) {
    protectorState.shieldStatus = 'ENGAGED';
    protectorState.shieldMode = 'THROTTLE';
    protectorState.lastReason = `${context.reason}; mitigation posture elevated`;
  } else if (onlineDevices.length > 0) {
    protectorState.shieldStatus = 'READY';
    protectorState.shieldMode = 'GUARD';
    protectorState.lastReason = 'Telemetry stable and protection grid online';
  } else {
    protectorState.shieldStatus = 'CALIBRATING';
    protectorState.shieldMode = 'WATCH';
    protectorState.lastReason = 'Waiting for active node telemetry';
  }

  protectorState.blockedEstimate = Math.max(
    protectorState.blockedEstimate,
    Math.round(attackRate * (protectorState.shieldMode === 'CONTAIN' ? 0.85 : protectorState.shieldMode === 'THROTTLE' ? 0.55 : 0.2))
  );

  if (
    (protectorState.shieldStatus === 'LOCKDOWN' || protectorState.shieldStatus === 'ENGAGED') &&
    shouldRegisterIncident(now, context.reason)
  ) {
    registerIncident(protectorState.shieldMode, `${context.reason}; exposure score ${exposure}`, now);
  }
}

function shouldRegisterIncident(now, reason) {
  const latest = protectorState.incidents[0];
  if (!latest) {
    return true;
  }

  return latest.reason !== reason || now - latest.startedAt > 20000;
}

function registerIncident(action, reason, timestamp) {
  protectorState.incidents.unshift({
    id: `DEF-${String(incidentSequence++).padStart(4, '0')}`,
    startedAt: timestamp,
    action,
    reason,
    attackRate: protectorState.attackRate,
    blockedEstimate: protectorState.blockedEstimate,
    exposure: getExposureScore(),
    assets: protectorState.protectedAssets,
    devicesOnline: getDevicesList().filter((device) => device.status === 'online').length
  });

  if (protectorState.incidents.length > 25) {
    protectorState.incidents.pop();
  }
}

function estimateBlockedTraffic() {
  const factor = protectorState.shieldMode === 'CONTAIN'
    ? 0.85
    : protectorState.shieldMode === 'THROTTLE'
      ? 0.55
      : 0.2;
  return Math.round(protectorState.attackRate * factor);
}

function getExposureScore() {
  const cappedRate = Math.min(protectorState.attackRate / Math.max(CRITICAL_PRESSURE_RATE, 1), 1);
  const assets = Math.min(protectorState.protectedAssets / 8, 1);
  const onlineDevices = Math.min(getDevicesList().filter((device) => device.status === 'online').length / 5, 1);
  return Number(((cappedRate * 0.55) + (assets * 0.25) + (onlineDevices * 0.2)).toFixed(2));
}

function getDevicesList() {
  const now = Date.now();
  const devices = [];

  for (const [id, device] of protectorState.devices.entries()) {
    const isOnline = now - device.lastSeen <= DEVICE_TIMEOUT_MS;

    if (!isOnline && device.status === 'online') {
      device.status = 'offline';
      addDefenseEvent({
        kind: 'device-offline',
        source: id,
        title: 'Device lost from telemetry',
        detail: 'Heartbeat timeout exceeded',
        severity: 'warning',
        timestamp: now
      });
    }

    devices.push({
      id,
      status: isOnline ? 'online' : 'offline',
      count: device.count,
      attackRate: device.attackRate,
      lastSeen: device.lastSeen,
      lastAttack: device.lastAttack,
      uptime: device.uptime,
      rssi: device.rssi,
      target: device.target,
      ip: device.ip,
      running: device.running
    });
  }

  return devices.sort((left, right) => {
    if (left.status === 'online' && right.status !== 'online') return -1;
    if (left.status !== 'online' && right.status === 'online') return 1;
    return right.lastSeen - left.lastSeen;
  });
}

function getTargetList() {
  return Array.from(protectorState.targetPressure.values())
    .sort((left, right) => right.hits - left.hits)
    .slice(0, 8);
}

function addDefenseEvent(event) {
  protectorState.defenseEvents.unshift({
    ...event,
    time: new Date(event.timestamp).toLocaleTimeString()
  });

  if (protectorState.defenseEvents.length > 120) {
    protectorState.defenseEvents.pop();
  }
}

function buildSnapshot() {
  const devices = getDevicesList();
  return {
    totalThreatEvents: protectorState.totalThreatEvents,
    attackRate: protectorState.attackRate,
    blockedEstimate: estimateBlockedTraffic(),
    peakRate: protectorState.peakRate,
    shieldStatus: protectorState.shieldStatus,
    shieldMode: protectorState.shieldMode,
    lastAction: protectorState.lastAction,
    lastReason: protectorState.lastReason,
    exposureScore: getExposureScore(),
    devices,
    incidents: protectorState.incidents.slice(0, 10),
    defenseEvents: protectorState.defenseEvents.slice(0, 60),
    history: protectorState.history,
    targets: getTargetList(),
    protectedAssets: protectorState.protectedAssets,
    timestamp: Date.now()
  };
}

function buildWorkbookXml() {
  const snapshot = buildSnapshot();
  const generatedAt = new Date();
  const incidentRows = snapshot.incidents.map((incident) => `
    <Row>
      <Cell><Data ss:Type="String">${escapeXml(incident.id)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(new Date(incident.startedAt).toISOString())}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(incident.action)}</Data></Cell>
      <Cell><Data ss:Type="Number">${incident.attackRate}</Data></Cell>
      <Cell><Data ss:Type="Number">${incident.blockedEstimate}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(incident.reason)}</Data></Cell>
    </Row>
  `).join('');

  const deviceRows = snapshot.devices.map((device) => `
    <Row>
      <Cell><Data ss:Type="String">${escapeXml(device.id)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(device.status)}</Data></Cell>
      <Cell><Data ss:Type="Number">${Number(device.attackRate || 0)}</Data></Cell>
      <Cell><Data ss:Type="Number">${Number(device.count || 0)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(device.target || 'Unknown')}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(device.ip || 'N/A')}</Data></Cell>
    </Row>
  `).join('');

  return `<?xml version="1.0"?>
  <?mso-application progid="Excel.Sheet"?>
  <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
    xmlns:o="urn:schemas-microsoft-com:office:office"
    xmlns:x="urn:schemas-microsoft-com:office:excel"
    xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Worksheet ss:Name="Summary">
      <Table>
        <Row><Cell><Data ss:Type="String">Generated At</Data></Cell><Cell><Data ss:Type="String">${escapeXml(generatedAt.toISOString())}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Shield Status</Data></Cell><Cell><Data ss:Type="String">${escapeXml(snapshot.shieldStatus)}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Shield Mode</Data></Cell><Cell><Data ss:Type="String">${escapeXml(snapshot.shieldMode)}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Threat Events</Data></Cell><Cell><Data ss:Type="Number">${snapshot.totalThreatEvents}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Current Attack Rate</Data></Cell><Cell><Data ss:Type="Number">${snapshot.attackRate}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Blocked Estimate</Data></Cell><Cell><Data ss:Type="Number">${snapshot.blockedEstimate}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Exposure Score</Data></Cell><Cell><Data ss:Type="Number">${snapshot.exposureScore}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Protected Assets</Data></Cell><Cell><Data ss:Type="Number">${snapshot.protectedAssets}</Data></Cell></Row>
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Incidents">
      <Table>
        <Row>
          <Cell><Data ss:Type="String">Incident ID</Data></Cell>
          <Cell><Data ss:Type="String">Started At</Data></Cell>
          <Cell><Data ss:Type="String">Action</Data></Cell>
          <Cell><Data ss:Type="String">Attack Rate</Data></Cell>
          <Cell><Data ss:Type="String">Blocked Estimate</Data></Cell>
          <Cell><Data ss:Type="String">Reason</Data></Cell>
        </Row>
        ${incidentRows}
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Devices">
      <Table>
        <Row>
          <Cell><Data ss:Type="String">Device ID</Data></Cell>
          <Cell><Data ss:Type="String">Status</Data></Cell>
          <Cell><Data ss:Type="String">Attack Rate</Data></Cell>
          <Cell><Data ss:Type="String">Total Events</Data></Cell>
          <Cell><Data ss:Type="String">Target</Data></Cell>
          <Cell><Data ss:Type="String">IP</Data></Cell>
        </Row>
        ${deviceRows}
      </Table>
    </Worksheet>
  </Workbook>`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function broadcastUpdate() {
  const snapshot = buildSnapshot();
  const signature = [
    snapshot.attackRate,
    snapshot.shieldStatus,
    snapshot.devices.length,
    snapshot.totalThreatEvents,
    snapshot.incidents.length
  ].join(':');

  io.emit('protector-update', snapshot);

  if (signature !== lastBroadcastSignature) {
    console.log(
      `Shield ${snapshot.shieldStatus} | Threat rate ${snapshot.attackRate}/s | Assets ${snapshot.protectedAssets} | Devices ${snapshot.devices.length}`
    );
    lastBroadcastSignature = signature;
  }
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/overview', (req, res) => {
  res.json(buildSnapshot());
});

app.get('/api/report/defense.xls', (req, res) => {
  const fileName = `protector-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.xls`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(buildWorkbookXml());
});

app.post('/api/shield-mode', (req, res) => {
  const requestedMode = String(req.body.mode || '').toUpperCase();
  if (!requestedMode) {
    res.status(400).json({ error: 'mode is required' });
    return;
  }

  protectorState.shieldMode = requestedMode;
  protectorState.shieldStatus = requestedMode === 'CONTAIN' ? 'LOCKDOWN' : requestedMode === 'THROTTLE' ? 'ENGAGED' : 'READY';
  protectorState.lastAction = requestedMode;
  protectorState.lastReason = `Operator set shield mode to ${requestedMode}`;
  addDefenseEvent({
    kind: 'manual-mode',
    source: 'protector-dashboard',
    title: `Operator switched shield mode to ${requestedMode}`,
    detail: 'Manual posture override',
    severity: 'info',
    timestamp: Date.now()
  });
  broadcastUpdate();

  res.json({ success: true, snapshot: buildSnapshot() });
});

app.get('/*path', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

setInterval(() => {
  const now = Date.now();
  getDevicesList();
  protectorState.blockedEstimate = estimateBlockedTraffic();
  protectorState.history.push({
    time: now,
    inbound: protectorState.attackRate,
    blocked: protectorState.blockedEstimate,
    exposure: getExposureScore()
  });
  if (protectorState.history.length > 120) {
    protectorState.history.shift();
  }
  broadcastUpdate();
}, 5000);

server.listen(PORT, () => {
  console.log('ESP Protector Dashboard');
  console.log(`Dashboard URL: http://localhost:${PORT}`);
  console.log(`MQTT broker: ${MQTT_BROKER_URL}:${MQTT_PORT}`);
  console.log('Monitoring shield posture and threat telemetry...');
});
