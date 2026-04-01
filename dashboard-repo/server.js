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

const PORT = Number(process.env.PORT || 3000);
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://broker.emqx.io';
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);
const MQTT_ATTACK_TOPIC = process.env.MQTT_ATTACK_TOPIC || 'attacks/count';
const MQTT_HEARTBEAT_TOPIC = process.env.MQTT_HEARTBEAT_TOPIC || 'devices/heartbeat';
const MQTT_STATUS_TOPIC = process.env.MQTT_STATUS_TOPIC || 'devices/status';
const MQTT_CONTROL_TOPIC = process.env.MQTT_CONTROL_TOPIC || 'devices/control';
const DEVICE_TIMEOUT_MS = Number(process.env.DEVICE_TIMEOUT_MS || 15000);
const MITIGATION_COOLDOWN_MS = Number(process.env.MITIGATION_COOLDOWN_MS || 30000);
const SAFE_RATE_LIMIT = Number(process.env.SAFE_RATE_LIMIT || 1);
const PUBLIC_DIR = path.join(__dirname, 'public');

const attackStats = {
  totalAttacks: 0,
  devices: new Map(),
  recentAttacks: [],
  attacksPerSecond: 0,
  attackHistory: [],
  incidents: []
};

const mitigationModel = {
  enabled: true,
  learningSamples: 0,
  ewmaRate: 0,
  variance: 1,
  riskScore: 0,
  baselineRate: 0,
  anomalyScore: 0,
  currentAction: 'MONITOR',
  status: 'LEARNING',
  lastMitigationAt: null,
  totalMitigations: 0,
  lastReason: 'Collecting baseline traffic',
  lastIncidentId: null
};

let attackTimestamps = [];
let lastBroadcast = null;
let previousAttackRate = 0;
let incidentSequence = 1;

const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  port: MQTT_PORT,
  keepalive: 60,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log(`Connected to MQTT broker at ${MQTT_BROKER_URL}:${MQTT_PORT}`);
  mqttClient.subscribe(MQTT_ATTACK_TOPIC);
  mqttClient.subscribe(MQTT_HEARTBEAT_TOPIC);
  mqttClient.subscribe(MQTT_STATUS_TOPIC);
  console.log('Subscribed to dashboard topics');
});

mqttClient.on('error', (error) => {
  console.error('MQTT error:', error.message);
});

mqttClient.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());

    if (topic === MQTT_ATTACK_TOPIC) {
      handleAttack(data);
    } else if (topic === MQTT_HEARTBEAT_TOPIC) {
      handleHeartbeat(data);
    } else if (topic === MQTT_STATUS_TOPIC) {
      handleStatus(data);
    }
  } catch (error) {
    console.error('MQTT payload parse error:', error.message);
  }
});

function handleAttack(data) {
  const { deviceId, type, target } = data;
  const now = Date.now();

  attackStats.totalAttacks++;

  if (!attackStats.devices.has(deviceId)) {
    attackStats.devices.set(deviceId, {
      count: 0,
      lastSeen: now,
      lastAttack: now,
      type: type || 'HTTP_GET',
      status: 'online',
      firstSeen: now,
      attackRate: 0
    });
    console.log(`New device detected: ${deviceId}`);
  }

  const device = attackStats.devices.get(deviceId);
  device.count++;
  device.lastSeen = now;
  device.lastAttack = now;
  device.status = 'online';
  device.type = type || device.type;
  if (target) {
    device.target = target;
  }

  if (!device.attackTimestamps) {
    device.attackTimestamps = [];
  }

  device.attackTimestamps.push(now);
  device.attackTimestamps = device.attackTimestamps.filter((ts) => now - ts < 1000);
  device.attackRate = device.attackTimestamps.length;

  const attack = {
    id: attackStats.totalAttacks,
    deviceId,
    timestamp: now,
    time: new Date(now).toLocaleTimeString(),
    type: device.type,
    target: target || device.target || 'Unknown',
    eventType: 'attack'
  };

  attackStats.recentAttacks.unshift(attack);
  if (attackStats.recentAttacks.length > 250) {
    attackStats.recentAttacks.pop();
  }

  attackTimestamps.push(now);
  attackTimestamps = attackTimestamps.filter((ts) => now - ts < 1000);
  attackStats.attacksPerSecond = attackTimestamps.length;

  attackStats.attackHistory.push({ time: now, count: attackStats.attacksPerSecond });
  if (attackStats.attackHistory.length > 120) {
    attackStats.attackHistory.shift();
  }

  evaluateMitigation('attack');
  broadcastUpdate(attack);
}

function handleHeartbeat(data) {
  const { deviceId, attacksSent, uptime, rssi, target, rate, attackRate, running } = data;
  const now = Date.now();
  let statusChanged = false;

  if (!attackStats.devices.has(deviceId)) {
    attackStats.devices.set(deviceId, {
      count: attacksSent || 0,
      lastSeen: now,
      lastAttack: now,
      type: 'HTTP_GET',
      status: 'online',
      firstSeen: now,
      uptime: uptime || 0,
      rssi: rssi || 0,
      target,
      attackRate: attackRate ?? rate ?? 0,
      running: running !== undefined ? running : true
    });

    console.log(`New device heartbeat: ${deviceId}`);
    statusChanged = true;
    pushRecentEvent(deviceId, 'connect', 'CONNECTION', 'Device Online', now);
  } else {
    const device = attackStats.devices.get(deviceId);
    const wasOffline = device.status === 'offline';

    device.lastSeen = now;
    device.status = 'online';
    if (attacksSent > device.count) device.count = attacksSent;
    if (uptime !== undefined) device.uptime = uptime;
    if (rssi !== undefined) device.rssi = rssi;
    if (target) device.target = target;
    if (attackRate !== undefined) device.attackRate = attackRate;
    else if (rate !== undefined) device.attackRate = rate;
    if (running !== undefined) device.running = running;

    if (wasOffline) {
      console.log(`Device back online: ${deviceId}`);
      statusChanged = true;
      pushRecentEvent(deviceId, 'reconnect', 'RECONNECT', 'Device Reconnected', now);
    }
  }

  evaluateMitigation('heartbeat');

  if (statusChanged) {
    broadcastUpdate();
  }
}

function handleStatus(data) {
  const { deviceId, ip, attackRate, target, attacksSent, running } = data;
  const now = Date.now();
  let statusChanged = false;

  if (!attackStats.devices.has(deviceId)) {
    attackStats.devices.set(deviceId, {
      count: attacksSent || 0,
      lastSeen: now,
      lastAttack: now,
      type: 'HTTP_GET',
      status: 'online',
      ip,
      attackRate: attackRate || 0,
      target,
      running: running !== undefined ? running : true,
      firstSeen: now
    });

    console.log(`New device status received: ${deviceId}`);
    statusChanged = true;
    pushRecentEvent(deviceId, 'connect', 'CONNECTION', 'Device Online', now);
  } else {
    const device = attackStats.devices.get(deviceId);
    const wasOffline = device.status === 'offline';

    device.status = 'online';
    device.lastSeen = now;
    if (ip) device.ip = ip;
    if (attackRate !== undefined) device.attackRate = attackRate;
    if (target) device.target = target;
    if (attacksSent > device.count) device.count = attacksSent;
    if (running !== undefined) device.running = running;

    if (wasOffline) {
      console.log(`Device back online from status update: ${deviceId}`);
      statusChanged = true;
      pushRecentEvent(deviceId, 'reconnect', 'RECONNECT', 'Device Reconnected', now);
    }
  }

  evaluateMitigation('status');

  if (statusChanged) {
    broadcastUpdate();
  }
}

function pushRecentEvent(deviceId, eventType, type, target, timestamp, details = {}) {
  attackStats.recentAttacks.unshift({
    deviceId,
    eventType,
    time: new Date(timestamp).toLocaleTimeString(),
    type,
    target,
    timestamp,
    ...details
  });

  if (attackStats.recentAttacks.length > 250) {
    attackStats.recentAttacks.pop();
  }
}

function getDevicesList() {
  const now = Date.now();
  const devicesList = [];

  for (const [id, device] of attackStats.devices.entries()) {
    const timeSinceLastSeen = now - device.lastSeen;
    const isOnline = timeSinceLastSeen <= DEVICE_TIMEOUT_MS;

    if (!isOnline && device.status === 'online') {
      device.status = 'offline';
      console.log(`Device ${id} went offline`);
      pushRecentEvent(id, 'disconnect', 'DISCONNECT', 'Connection Timeout', now);
    }

    devicesList.push({
      id,
      count: device.count,
      lastSeen: device.lastSeen,
      lastAttack: device.lastAttack,
      type: device.type,
      status: isOnline ? 'online' : 'offline',
      ip: device.ip,
      attackRate: device.attackRate,
      target: device.target,
      uptime: device.uptime,
      rssi: device.rssi,
      running: device.running
    });
  }

  return devicesList.sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (a.status !== 'online' && b.status === 'online') return 1;
    return b.lastSeen - a.lastSeen;
  });
}

function getTrafficSnapshot() {
  const devices = getDevicesList();
  const onlineDevices = devices.filter((device) => device.status === 'online');
  const activeAttackers = onlineDevices.filter((device) => (device.attackRate || 0) > 0);
  const peakDeviceRate = activeAttackers.reduce((max, device) => Math.max(max, device.attackRate || 0), 0);
  const primaryTarget = findPrimaryTarget(activeAttackers);

  return {
    devices,
    onlineCount: onlineDevices.length,
    activeAttackers: activeAttackers.length,
    peakDeviceRate,
    primaryTarget
  };
}

function findPrimaryTarget(devices) {
  const counts = new Map();
  for (const device of devices) {
    if (!device.target) {
      continue;
    }
    counts.set(device.target, (counts.get(device.target) || 0) + 1);
  }

  let winner = 'Unknown';
  let highest = 0;
  for (const [target, count] of counts.entries()) {
    if (count > highest) {
      winner = target;
      highest = count;
    }
  }

  return winner;
}

function updateBaseline(currentRate) {
  const alpha = 0.12;

  if (mitigationModel.learningSamples === 0) {
    mitigationModel.ewmaRate = currentRate;
    mitigationModel.variance = 1;
  } else {
    const delta = currentRate - mitigationModel.ewmaRate;
    mitigationModel.ewmaRate += alpha * delta;
    mitigationModel.variance = (1 - alpha) * (mitigationModel.variance + alpha * delta * delta);
  }

  mitigationModel.learningSamples += 1;
  mitigationModel.baselineRate = Number(mitigationModel.ewmaRate.toFixed(2));
}

function evaluateMitigation(source) {
  if (!mitigationModel.enabled) {
    return;
  }

  const snapshot = getTrafficSnapshot();
  const currentRate = attackStats.attacksPerSecond;
  const rateDelta = Math.max(0, currentRate - previousAttackRate);
  const stdDev = Math.max(1, Math.sqrt(mitigationModel.variance));
  const anomalyScore = mitigationModel.learningSamples >= 5
    ? Math.max(0, (currentRate - mitigationModel.ewmaRate) / stdDev)
    : Math.max(0, currentRate / 5);

  mitigationModel.anomalyScore = Number(anomalyScore.toFixed(2));

  if (currentRate <= mitigationModel.baselineRate + 1 || mitigationModel.learningSamples < 5) {
    updateBaseline(currentRate);
  }

  const riskScore = Math.min(
    1,
    anomalyScore * 0.22 +
      Math.min(currentRate / 30, 1) * 0.35 +
      Math.min(snapshot.activeAttackers / 5, 1) * 0.2 +
      Math.min(rateDelta / 10, 1) * 0.15 +
      Math.min(snapshot.peakDeviceRate / 20, 1) * 0.08
  );

  mitigationModel.riskScore = Number(riskScore.toFixed(2));

  if (mitigationModel.learningSamples < 5) {
    mitigationModel.status = 'LEARNING';
    mitigationModel.currentAction = 'MONITOR';
    mitigationModel.lastReason = 'Collecting baseline traffic';
    previousAttackRate = currentRate;
    return;
  }

  if (riskScore >= 0.9 && shouldMitigate()) {
    mitigationModel.status = 'CRITICAL';
    mitigationModel.currentAction = 'STOP';
    mitigationModel.lastReason = `Critical anomaly detected from ${source}`;
    createIncidentAndMitigate('STOP', snapshot, currentRate, riskScore, `Critical anomaly detected from ${source}`);
  } else if (riskScore >= 0.7 && shouldMitigate()) {
    mitigationModel.status = 'HIGH';
    mitigationModel.currentAction = 'THROTTLE';
    mitigationModel.lastReason = `Suspicious surge detected from ${source}`;
    createIncidentAndMitigate('THROTTLE', snapshot, currentRate, riskScore, `Suspicious surge detected from ${source}`);
  } else if (riskScore >= 0.45) {
    mitigationModel.status = 'WATCH';
    mitigationModel.currentAction = 'MONITOR';
    mitigationModel.lastReason = 'Traffic elevated but within watch window';
  } else {
    mitigationModel.status = 'STABLE';
    mitigationModel.currentAction = 'MONITOR';
    mitigationModel.lastReason = 'Traffic within learned baseline';
  }

  previousAttackRate = currentRate;
}

function shouldMitigate() {
  return !mitigationModel.lastMitigationAt || Date.now() - mitigationModel.lastMitigationAt > MITIGATION_COOLDOWN_MS;
}

function createIncidentAndMitigate(action, snapshot, currentRate, riskScore, reason) {
  const incident = {
    id: `INC-${String(incidentSequence++).padStart(4, '0')}`,
    startedAt: Date.now(),
    action,
    reason,
    riskScore: Number(riskScore.toFixed(2)),
    attackRate: currentRate,
    totalAttacks: attackStats.totalAttacks,
    onlineCount: snapshot.onlineCount,
    activeAttackers: snapshot.activeAttackers,
    primaryTarget: snapshot.primaryTarget,
    devices: snapshot.devices
      .filter((device) => device.status === 'online')
      .map((device) => ({
        id: device.id,
        attackRate: device.attackRate || 0,
        count: device.count,
        target: device.target || 'Unknown'
      }))
  };

  attackStats.incidents.unshift(incident);
  if (attackStats.incidents.length > 50) {
    attackStats.incidents.pop();
  }

  mitigationModel.lastIncidentId = incident.id;
  mitigationModel.lastMitigationAt = incident.startedAt;
  mitigationModel.totalMitigations += 1;

  if (action === 'THROTTLE') {
    publishControlMessage({
      action: 'START',
      rate: SAFE_RATE_LIMIT,
      duration: 60,
      target: snapshot.primaryTarget !== 'Unknown' ? snapshot.primaryTarget : undefined
    });
  } else {
    publishControlMessage({ action: 'STOP' });
  }

  pushRecentEvent(
    'AUTO-MITIGATOR',
    'mitigation',
    action,
    reason,
    incident.startedAt,
    { riskScore: incident.riskScore, incidentId: incident.id }
  );

  console.log(`Auto-mitigation triggered: ${action} | ${reason}`);
}

function publishControlMessage(command) {
  mqttClient.publish(MQTT_CONTROL_TOPIC, JSON.stringify({
    ...command,
    timestamp: Date.now(),
    source: 'dashboard-auto-mitigator'
  }));
}

function getMitigationState() {
  return {
    enabled: mitigationModel.enabled,
    status: mitigationModel.status,
    currentAction: mitigationModel.currentAction,
    riskScore: mitigationModel.riskScore,
    anomalyScore: mitigationModel.anomalyScore,
    baselineRate: mitigationModel.baselineRate,
    totalMitigations: mitigationModel.totalMitigations,
    lastMitigationAt: mitigationModel.lastMitigationAt,
    lastReason: mitigationModel.lastReason,
    lastIncidentId: mitigationModel.lastIncidentId
  };
}

function broadcastUpdate(recentAttack = null) {
  const snapshot = getTrafficSnapshot();

  const updateData = {
    totalAttacks: attackStats.totalAttacks,
    attacksPerSecond: attackStats.attacksPerSecond,
    devices: snapshot.devices,
    history: attackStats.attackHistory,
    onlineCount: snapshot.onlineCount,
    timestamp: Date.now(),
    mitigation: getMitigationState(),
    incidents: attackStats.incidents.slice(0, 10)
  };

  if (recentAttack) {
    updateData.recentAttack = recentAttack;
  }

  io.emit('attack-update', updateData);

  if (lastBroadcast !== snapshot.onlineCount) {
    console.log(
      `Active nodes: ${snapshot.onlineCount} | Total attacks: ${attackStats.totalAttacks} | Rate: ${attackStats.attacksPerSecond}/s`
    );
    lastBroadcast = snapshot.onlineCount;
  }
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildWorkbookXml() {
  const snapshot = getTrafficSnapshot();
  const mitigation = getMitigationState();
  const generatedAt = new Date();
  const devicesRows = snapshot.devices
    .map((device) => `
      <Row>
        <Cell><Data ss:Type="String">${escapeXml(device.id)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(device.status)}</Data></Cell>
        <Cell><Data ss:Type="Number">${Number(device.attackRate || 0)}</Data></Cell>
        <Cell><Data ss:Type="Number">${Number(device.count || 0)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(device.target || 'Unknown')}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(device.ip || 'N/A')}</Data></Cell>
      </Row>
    `)
    .join('');

  const incidentRows = attackStats.incidents
    .map((incident) => `
      <Row>
        <Cell><Data ss:Type="String">${escapeXml(incident.id)}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(new Date(incident.startedAt).toISOString())}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(incident.action)}</Data></Cell>
        <Cell><Data ss:Type="Number">${incident.riskScore}</Data></Cell>
        <Cell><Data ss:Type="Number">${incident.attackRate}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(incident.primaryTarget || 'Unknown')}</Data></Cell>
        <Cell><Data ss:Type="String">${escapeXml(incident.reason)}</Data></Cell>
      </Row>
    `)
    .join('');

  const logRows = attackStats.recentAttacks.slice(0, 100).map((entry) => `
    <Row>
      <Cell><Data ss:Type="String">${escapeXml(entry.time)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(entry.deviceId)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(entry.eventType)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(entry.target)}</Data></Cell>
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
        <Row><Cell><Data ss:Type="String">Total Attacks</Data></Cell><Cell><Data ss:Type="Number">${attackStats.totalAttacks}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Current Attack Rate</Data></Cell><Cell><Data ss:Type="Number">${attackStats.attacksPerSecond}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Online Devices</Data></Cell><Cell><Data ss:Type="Number">${snapshot.onlineCount}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Mitigation Status</Data></Cell><Cell><Data ss:Type="String">${escapeXml(mitigation.status)}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Mitigation Action</Data></Cell><Cell><Data ss:Type="String">${escapeXml(mitigation.currentAction)}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Risk Score</Data></Cell><Cell><Data ss:Type="Number">${mitigation.riskScore}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Last Reason</Data></Cell><Cell><Data ss:Type="String">${escapeXml(mitigation.lastReason)}</Data></Cell></Row>
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Devices">
      <Table>
        <Row>
          <Cell><Data ss:Type="String">Device ID</Data></Cell>
          <Cell><Data ss:Type="String">Status</Data></Cell>
          <Cell><Data ss:Type="String">Attack Rate</Data></Cell>
          <Cell><Data ss:Type="String">Total Attacks</Data></Cell>
          <Cell><Data ss:Type="String">Target</Data></Cell>
          <Cell><Data ss:Type="String">IP</Data></Cell>
        </Row>
        ${devicesRows}
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Incidents">
      <Table>
        <Row>
          <Cell><Data ss:Type="String">Incident ID</Data></Cell>
          <Cell><Data ss:Type="String">Started At</Data></Cell>
          <Cell><Data ss:Type="String">Action</Data></Cell>
          <Cell><Data ss:Type="String">Risk Score</Data></Cell>
          <Cell><Data ss:Type="String">Attack Rate</Data></Cell>
          <Cell><Data ss:Type="String">Primary Target</Data></Cell>
          <Cell><Data ss:Type="String">Reason</Data></Cell>
        </Row>
        ${incidentRows}
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Recent Log">
      <Table>
        <Row>
          <Cell><Data ss:Type="String">Time</Data></Cell>
          <Cell><Data ss:Type="String">Source</Data></Cell>
          <Cell><Data ss:Type="String">Event</Data></Cell>
          <Cell><Data ss:Type="String">Target</Data></Cell>
        </Row>
        ${logRows}
      </Table>
    </Worksheet>
  </Workbook>`;
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get('/api/stats', (req, res) => {
  const snapshot = getTrafficSnapshot();
  res.json({
    totalAttacks: attackStats.totalAttacks,
    attacksPerSecond: attackStats.attacksPerSecond,
    devices: snapshot.devices,
    recentAttacks: attackStats.recentAttacks.slice(0, 100),
    history: attackStats.attackHistory,
    mitigation: getMitigationState(),
    incidents: attackStats.incidents.slice(0, 10)
  });
});

app.get('/api/report/incident.xls', (req, res) => {
  const fileName = `incident-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.xls`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(buildWorkbookXml());
});

app.post('/api/control', (req, res) => {
  const { action, target, rate, duration } = req.body;
  console.log(`Control request: ${action} | Target: ${target} | Rate: ${rate}`);

  const controlMessage = {
    action,
    target,
    rate,
    duration,
    timestamp: Date.now(),
    source: 'dashboard-manual-control'
  };

  mqttClient.publish(MQTT_CONTROL_TOPIC, JSON.stringify(controlMessage), (error) => {
    if (error) {
      console.error('Failed to send command:', error.message);
      res.status(500).json({ error: 'Failed to send command' });
      return;
    }

    res.json({ success: true, message: `Command ${action} sent` });
  });
});

app.post('/api/mitigation/toggle', (req, res) => {
  mitigationModel.enabled = Boolean(req.body.enabled);
  mitigationModel.status = mitigationModel.enabled ? mitigationModel.status : 'DISABLED';
  mitigationModel.currentAction = mitigationModel.enabled ? mitigationModel.currentAction : 'MANUAL';
  mitigationModel.lastReason = mitigationModel.enabled
    ? 'Auto-mitigation enabled'
    : 'Auto-mitigation disabled by operator';

  res.json({ success: true, mitigation: getMitigationState() });
  broadcastUpdate();
});

app.get('/*path', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

setInterval(() => {
  const now = Date.now();
  let needsUpdate = false;

  for (const [id, device] of attackStats.devices.entries()) {
    if (now - device.lastSeen > DEVICE_TIMEOUT_MS && device.status === 'online') {
      device.status = 'offline';
      needsUpdate = true;
      console.log(`Device ${id} marked offline`);
      pushRecentEvent(id, 'disconnect', 'DISCONNECT', 'Connection Timeout', now);
    }
  }

  evaluateMitigation('interval');

  if (needsUpdate) {
    broadcastUpdate();
  }
}, 5000);

server.listen(PORT, () => {
  console.log('ESP Attack Dashboard');
  console.log(`Dashboard URL: http://localhost:${PORT}`);
  console.log(`MQTT broker: ${MQTT_BROKER_URL}:${MQTT_PORT}`);
  console.log(`Device timeout: ${DEVICE_TIMEOUT_MS / 1000} seconds`);
  console.log('Monitoring for device traffic...');
});
