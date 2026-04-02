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
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_GROUPS = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const TASK_TYPES = ['Load Test', 'Burst Mode Validation', 'Firmware Rollout'];

const controlConfig = {
  targetHost: 'httpbin.org',
  targetPort: 443,
  requestRate: 10,
  duration: 0,
  startMode: 'immediate',
  scheduledAt: '',
  delayMs: 0,
  maxRequests: 1000,
  targets: ['httpbin.org'],
  burstMode: false,
  advancedControl: false
};

const attackStats = {
  totalAttacks: 0,
  devices: new Map(),
  recentAttacks: [],
  attacksPerSecond: 0,
  attackHistory: [],
  incidents: [],
  requestsDeltaHistory: []
};

const systemState = {
  mqttConnected: false,
  mqttLastConnectedAt: null,
  otaServerReady: true,
  apiLatencyMs: 18,
  status: 'Stopped',
  lastCommandAt: null,
  activeDevices: 0,
  requestsIncreasePct: 0
};

const otaState = {
  available: false,
  version: 'n/a',
  fileName: '',
  fileSize: 0,
  uploadedAt: null,
  rollout: {
    active: false,
    progress: 0,
    success: 0,
    updating: 0,
    failed: 0,
    logs: []
  }
};

const tasks = [
  {
    id: 'TASK-0001',
    name: 'Morning Load Test',
    type: 'Load Test',
    targetHost: 'httpbin.org',
    targetPort: 443,
    rate: 12,
    duration: 180,
    delayMs: 0,
    group: 'Alpha',
    executionMode: 'scheduled',
    scheduledAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    status: 'Scheduled'
  },
  {
    id: 'TASK-0002',
    name: 'Firmware Rollout Dry Run',
    type: 'Firmware Rollout',
    targetHost: 'ota.internal',
    targetPort: 8080,
    rate: 0,
    duration: 0,
    delayMs: 500,
    group: 'Beta',
    executionMode: 'recurring',
    scheduledAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    status: 'Recurring'
  }
];

let taskSequence = tasks.length + 1;
let incidentSequence = 1;
let attackTimestamps = [];
let previousAttackRate = 0;

const mqttClient = mqtt.connect(MQTT_BROKER_URL, {
  port: MQTT_PORT,
  keepalive: 60,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  systemState.mqttConnected = true;
  systemState.mqttLastConnectedAt = Date.now();
  mqttClient.subscribe([MQTT_ATTACK_TOPIC, MQTT_HEARTBEAT_TOPIC, MQTT_STATUS_TOPIC]);
  broadcastUpdate();
});

mqttClient.on('reconnect', () => {
  systemState.mqttConnected = false;
});

mqttClient.on('close', () => {
  systemState.mqttConnected = false;
  broadcastUpdate();
});

mqttClient.on('error', (error) => {
  systemState.mqttConnected = false;
  console.error('MQTT error:', error.message);
});

mqttClient.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    if (topic === MQTT_ATTACK_TOPIC) handleAttack(data);
    else if (topic === MQTT_HEARTBEAT_TOPIC) handleHeartbeat(data);
    else if (topic === MQTT_STATUS_TOPIC) handleStatus(data);
  } catch (error) {
    console.error('MQTT payload parse error:', error.message);
  }
});

function ensureDevice(deviceId, now = Date.now()) {
  if (!attackStats.devices.has(deviceId)) {
    attackStats.devices.set(deviceId, {
      id: deviceId,
      ip: 'N/A',
      count: 0,
      attackRate: 0,
      status: 'online',
      activityState: 'Idle',
      type: 'HTTP_GET',
      group: DEFAULT_GROUPS[attackStats.devices.size % DEFAULT_GROUPS.length],
      firmwareVersion: '1.0.0',
      lastSeen: now,
      lastAttack: now,
      uptime: 0,
      rssi: 0,
      running: false,
      selected: false,
      target: controlConfig.targetHost,
      attackTimestamps: []
    });

    pushRecentEvent(deviceId, 'connect', 'Device Online', 'info', now);
  }

  return attackStats.devices.get(deviceId);
}

function handleAttack(data) {
  const now = Date.now();
  const deviceId = data.deviceId || 'unknown-device';
  const device = ensureDevice(deviceId, now);

  attackStats.totalAttacks += 1;
  device.count += 1;
  device.lastSeen = now;
  device.lastAttack = now;
  device.status = 'online';
  device.running = true;
  device.activityState = 'Running';
  device.type = data.type || device.type;
  device.target = data.target || device.target || controlConfig.targetHost;

  device.attackTimestamps.push(now);
  device.attackTimestamps = device.attackTimestamps.filter((timestamp) => now - timestamp < 1000);
  device.attackRate = device.attackTimestamps.length;

  attackTimestamps.push(now);
  attackTimestamps = attackTimestamps.filter((timestamp) => now - timestamp < 1000);
  attackStats.attacksPerSecond = attackTimestamps.length;

  attackStats.attackHistory.push({
    time: now,
    count: attackStats.attacksPerSecond,
    blocked: Math.round(attackStats.attacksPerSecond * 0.18)
  });
  if (attackStats.attackHistory.length > 120) attackStats.attackHistory.shift();

  updateSystemLoad();
  const entry = {
    id: `EVT-${attackStats.totalAttacks}`,
    deviceId,
    eventType: 'attack',
    title: 'Request traffic observed',
    target: device.target,
    severity: attackStats.attacksPerSecond > 20 ? 'critical' : attackStats.attacksPerSecond > 8 ? 'warning' : 'info',
    time: new Date(now).toLocaleTimeString(),
    timestamp: now
  };
  attackStats.recentAttacks.unshift(entry);
  if (attackStats.recentAttacks.length > 150) attackStats.recentAttacks.pop();

  maybeCreateIncident(device.target, now);
  broadcastUpdate(entry);
}

function handleHeartbeat(data) {
  const now = Date.now();
  const device = ensureDevice(data.deviceId || 'unknown-device', now);
  device.lastSeen = now;
  device.status = 'online';
  device.running = Boolean(data.running);
  device.activityState = device.running ? 'Running' : 'Idle';
  device.uptime = Number(data.uptime || device.uptime || 0);
  device.rssi = Number(data.rssi || device.rssi || 0);
  device.target = data.target || device.target || controlConfig.targetHost;
  device.attackRate = Number(data.attackRate ?? data.rate ?? device.attackRate ?? 0);
  device.count = Math.max(device.count, Number(data.attacksSent || 0));
  updateSystemLoad();
  broadcastUpdate();
}

function handleStatus(data) {
  const now = Date.now();
  const device = ensureDevice(data.deviceId || 'unknown-device', now);
  device.lastSeen = now;
  device.status = 'online';
  device.ip = data.ip || device.ip;
  device.target = data.target || device.target;
  device.attackRate = Number(data.attackRate ?? device.attackRate ?? 0);
  device.count = Math.max(device.count, Number(data.attacksSent || 0));
  device.running = data.running !== undefined ? Boolean(data.running) : device.running;
  device.activityState = device.running ? 'Running' : 'Idle';
  updateSystemLoad();
  broadcastUpdate();
}

function pushRecentEvent(deviceId, title, target, severity, timestamp, extra = {}) {
  attackStats.recentAttacks.unshift({
    id: `LOG-${timestamp}-${deviceId}`,
    deviceId,
    eventType: extra.eventType || 'system',
    title,
    target,
    severity,
    time: new Date(timestamp).toLocaleTimeString(),
    timestamp,
    ...extra
  });

  if (attackStats.recentAttacks.length > 150) attackStats.recentAttacks.pop();
}

function maybeCreateIncident(target, now) {
  if (attackStats.attacksPerSecond < 10) return;

  const latest = attackStats.incidents[0];
  if (latest && now - latest.startedAt < 20000) return;

  attackStats.incidents.unshift({
    id: `INC-${String(incidentSequence++).padStart(4, '0')}`,
    startedAt: now,
    action: attackStats.attacksPerSecond > 20 ? 'Emergency Review' : 'Throttle Review',
    riskScore: Number(Math.min(0.99, attackStats.attacksPerSecond / 30).toFixed(2)),
    attackRate: attackStats.attacksPerSecond,
    primaryTarget: target || controlConfig.targetHost,
    reason: attackStats.attacksPerSecond > 20 ? 'Sustained burst traffic detected' : 'Elevated traffic detected'
  });
  if (attackStats.incidents.length > 50) attackStats.incidents.pop();
}

function getDevicesList() {
  const now = Date.now();
  return Array.from(attackStats.devices.values()).map((device) => {
    const online = now - device.lastSeen <= DEVICE_TIMEOUT_MS;
    const status = online ? 'online' : 'offline';
    if (!online) {
      device.running = false;
      device.activityState = 'Offline';
    }
    return {
      id: device.id,
      ip: device.ip,
      count: device.count,
      attackRate: device.attackRate,
      status,
      activityState: online ? device.activityState : 'Offline',
      type: device.type,
      group: device.group,
      firmwareVersion: device.firmwareVersion,
      lastSeen: device.lastSeen,
      lastAttack: device.lastAttack,
      uptime: device.uptime,
      rssi: device.rssi,
      running: online ? device.running : false,
      target: device.target
    };
  }).sort((left, right) => {
    if (left.status === 'online' && right.status !== 'online') return -1;
    if (left.status !== 'online' && right.status === 'online') return 1;
    return right.lastSeen - left.lastSeen;
  });
}

function getGroupSummary(devices) {
  const groups = new Map();
  for (const device of devices) {
    const current = groups.get(device.group) || { name: device.group, total: 0, online: 0 };
    current.total += 1;
    if (device.status === 'online') current.online += 1;
    groups.set(device.group, current);
  }
  return Array.from(groups.values());
}

function getTargetsSummary(devices) {
  const targets = new Map();
  for (const device of devices) {
    const key = device.target || 'Unknown';
    const current = targets.get(key) || { target: key, hits: 0, peakRate: 0, deviceCount: 0 };
    current.hits += device.count;
    current.peakRate = Math.max(current.peakRate, device.attackRate || 0);
    current.deviceCount += 1;
    targets.set(key, current);
  }
  return Array.from(targets.values()).sort((a, b) => b.hits - a.hits);
}

function updateSystemLoad() {
  const devices = getDevicesList();
  const online = devices.filter((device) => device.status === 'online');
  const delta = Math.max(0, attackStats.attacksPerSecond - previousAttackRate);
  systemState.activeDevices = online.length;
  systemState.requestsIncreasePct = previousAttackRate === 0
    ? attackStats.attacksPerSecond > 0 ? 100 : 0
    : Number(((delta / previousAttackRate) * 100).toFixed(1));
  systemState.status = online.some((device) => device.running) ? 'Running' : 'Stopped';
  attackStats.requestsDeltaHistory.push(systemState.requestsIncreasePct);
  if (attackStats.requestsDeltaHistory.length > 120) attackStats.requestsDeltaHistory.shift();
  previousAttackRate = attackStats.attacksPerSecond;
}

function simulateApiLatency() {
  systemState.apiLatencyMs = 14 + Math.round(Math.random() * 18);
}

function publishControlMessage(message) {
  systemState.lastCommandAt = Date.now();
  mqttClient.publish(MQTT_CONTROL_TOPIC, JSON.stringify({
    ...message,
    timestamp: Date.now(),
    source: 'dashboard-control-center'
  }));
}

function saveControlConfig(payload = {}) {
  controlConfig.targetHost = payload.targetHost || controlConfig.targetHost;
  controlConfig.targetPort = Number(payload.targetPort ?? controlConfig.targetPort);
  controlConfig.requestRate = Number(payload.requestRate ?? controlConfig.requestRate);
  controlConfig.duration = Number(payload.duration ?? controlConfig.duration);
  controlConfig.startMode = payload.startMode || controlConfig.startMode;
  controlConfig.scheduledAt = payload.scheduledAt ?? controlConfig.scheduledAt;
  controlConfig.delayMs = Number(payload.delayMs ?? controlConfig.delayMs);
  controlConfig.maxRequests = Number(payload.maxRequests ?? controlConfig.maxRequests);
  controlConfig.targets = Array.isArray(payload.targets)
    ? payload.targets.filter(Boolean)
    : String(payload.targets || controlConfig.targets.join(','))
      .split(',')
      .map((target) => target.trim())
      .filter(Boolean);
  controlConfig.burstMode = Boolean(payload.burstMode);
  controlConfig.advancedControl = Boolean(payload.advancedControl);
}

function getDashboardState() {
  simulateApiLatency();
  const devices = getDevicesList();
  const onlineDevices = devices.filter((device) => device.status === 'online');

  return {
    stats: {
      totalAttacks: attackStats.totalAttacks,
      attacksPerSecond: attackStats.attacksPerSecond,
      peakRate: attackStats.attackHistory.reduce((max, point) => Math.max(max, point.count || 0), 0),
      onlineDevices: onlineDevices.length,
      requestsIncreasePct: systemState.requestsIncreasePct,
      status: systemState.status
    },
    controlConfig,
    devices,
    groups: getGroupSummary(devices),
    targets: getTargetsSummary(devices),
    recentAttacks: attackStats.recentAttacks.slice(0, 100),
    history: attackStats.attackHistory,
    incidents: attackStats.incidents.slice(0, 20),
    tasks,
    ota: otaState,
    system: {
      mqttBroker: {
        url: `${MQTT_BROKER_URL}:${MQTT_PORT}`,
        status: systemState.mqttConnected ? 'Connected' : 'Disconnected'
      },
      backendApi: {
        latencyMs: systemState.apiLatencyMs,
        status: systemState.apiLatencyMs < 50 ? 'Healthy' : 'Degraded'
      },
      otaServer: {
        status: systemState.otaServerReady ? 'Ready' : 'Offline'
      }
    }
  };
}

function broadcastUpdate(extra = {}) {
  io.emit('dashboard-update', {
    ...getDashboardState(),
    ...extra,
    timestamp: Date.now()
  });
}

function buildWorkbookXml() {
  const state = getDashboardState();
  const devicesRows = state.devices.map((device) => `
    <Row>
      <Cell><Data ss:Type="String">${escapeXml(device.id)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(device.ip || 'N/A')}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(device.group)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(device.status)}</Data></Cell>
      <Cell><Data ss:Type="Number">${Number(device.attackRate || 0)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(device.firmwareVersion || 'n/a')}</Data></Cell>
    </Row>
  `).join('');

  const taskRows = state.tasks.map((task) => `
    <Row>
      <Cell><Data ss:Type="String">${escapeXml(task.id)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(task.type)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(task.group)}</Data></Cell>
      <Cell><Data ss:Type="Number">${Number(task.rate || 0)}</Data></Cell>
      <Cell><Data ss:Type="Number">${Number(task.delayMs || 0)}</Data></Cell>
      <Cell><Data ss:Type="String">${escapeXml(task.status)}</Data></Cell>
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
        <Row><Cell><Data ss:Type="String">Total Attacks</Data></Cell><Cell><Data ss:Type="Number">${state.stats.totalAttacks}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Requests Per Second</Data></Cell><Cell><Data ss:Type="Number">${state.stats.attacksPerSecond}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">Online Devices</Data></Cell><Cell><Data ss:Type="Number">${state.stats.onlineDevices}</Data></Cell></Row>
        <Row><Cell><Data ss:Type="String">System Status</Data></Cell><Cell><Data ss:Type="String">${escapeXml(state.stats.status)}</Data></Cell></Row>
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Devices">
      <Table>
        <Row>
          <Cell><Data ss:Type="String">Device ID</Data></Cell>
          <Cell><Data ss:Type="String">IP</Data></Cell>
          <Cell><Data ss:Type="String">Group</Data></Cell>
          <Cell><Data ss:Type="String">Status</Data></Cell>
          <Cell><Data ss:Type="String">Rate</Data></Cell>
          <Cell><Data ss:Type="String">Firmware</Data></Cell>
        </Row>
        ${devicesRows}
      </Table>
    </Worksheet>
    <Worksheet ss:Name="Tasks">
      <Table>
        <Row>
          <Cell><Data ss:Type="String">Task ID</Data></Cell>
          <Cell><Data ss:Type="String">Type</Data></Cell>
          <Cell><Data ss:Type="String">Group</Data></Cell>
          <Cell><Data ss:Type="String">Rate</Data></Cell>
          <Cell><Data ss:Type="String">Delay</Data></Cell>
          <Cell><Data ss:Type="String">Status</Data></Cell>
        </Row>
        ${taskRows}
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

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/stats', (req, res) => {
  res.json(getDashboardState());
});

app.get('/api/report/incident.xls', (req, res) => {
  const fileName = `control-center-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.xls`;
  res.setHeader('Content-Type', 'application/vnd.ms-excel');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(buildWorkbookXml());
});

app.post('/api/config', (req, res) => {
  saveControlConfig(req.body);
  broadcastUpdate();
  res.json({ success: true, controlConfig });
});

app.post('/api/control', (req, res) => {
  saveControlConfig(req.body);
  const action = String(req.body.action || 'START').toUpperCase();
  const targets = controlConfig.targets.length > 0 ? controlConfig.targets : [controlConfig.targetHost];
  publishControlMessage({
    action,
    target: targets[0],
    targets,
    port: controlConfig.targetPort,
    rate: controlConfig.requestRate,
    duration: controlConfig.duration,
    delayMs: controlConfig.delayMs,
    maxRequests: controlConfig.maxRequests,
    burstMode: controlConfig.burstMode,
    advancedControl: controlConfig.advancedControl,
    selectedDevices: req.body.selectedDevices || [],
    group: req.body.group || null
  });

  systemState.status = action === 'STOP' ? 'Stopped' : 'Running';
  pushRecentEvent('CONTROL-CENTER', `${action} swarm command`, targets.join(', '), action === 'STOP' ? 'warning' : 'info', Date.now(), { eventType: 'command' });
  broadcastUpdate();
  res.json({ success: true, message: `${action} command sent`, controlConfig });
});

app.post('/api/devices/action', (req, res) => {
  const action = String(req.body.action || '').toUpperCase();
  const deviceIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds : [];
  const selected = getDevicesList().filter((device) => deviceIds.includes(device.id));

  if (action === 'UPDATE_FIRMWARE' && otaState.available) {
    otaState.rollout.active = true;
    otaState.rollout.progress = 15;
    otaState.rollout.updating = selected.length;
    otaState.rollout.success = 0;
    otaState.rollout.failed = 0;
    otaState.rollout.logs = selected.map((device) => ({
      deviceId: device.id,
      status: 'Downloading',
      progress: 15
    }));
  }

  for (const deviceId of deviceIds) {
    const device = attackStats.devices.get(deviceId);
    if (!device) continue;
    if (action === 'START_ATTACK') {
      device.running = true;
      device.activityState = 'Running';
    } else if (action === 'STOP_TASK') {
      device.running = false;
      device.activityState = 'Idle';
      device.attackRate = 0;
    } else if (action === 'REBOOT_NODES') {
      device.activityState = 'Idle';
    } else if (action === 'ASSIGN_GROUP' && req.body.group) {
      device.group = req.body.group;
    }
  }

  pushRecentEvent('DEVICE-MANAGER', `${action.replaceAll('_', ' ')} issued`, `${deviceIds.length} devices`, 'info', Date.now(), { eventType: 'device-action' });
  broadcastUpdate();
  res.json({ success: true });
});

app.post('/api/tasks', (req, res) => {
  const task = {
    id: `TASK-${String(taskSequence++).padStart(4, '0')}`,
    name: req.body.name || `Task ${taskSequence - 1}`,
    type: TASK_TYPES.includes(req.body.type) ? req.body.type : 'Load Test',
    targetHost: req.body.targetHost || controlConfig.targetHost,
    targetPort: Number(req.body.targetPort ?? controlConfig.targetPort),
    rate: Number(req.body.rate ?? controlConfig.requestRate),
    duration: Number(req.body.duration ?? controlConfig.duration),
    delayMs: Number(req.body.delayMs ?? controlConfig.delayMs),
    group: req.body.group || 'All online devices',
    executionMode: req.body.executionMode || 'immediate',
    scheduledAt: req.body.scheduledAt || new Date().toISOString(),
    status: req.body.executionMode === 'recurring' ? 'Recurring' : req.body.executionMode === 'scheduled' ? 'Scheduled' : 'Queued'
  };
  tasks.unshift(task);
  pushRecentEvent('TASK-SCHEDULER', `Task created: ${task.name}`, task.type, 'info', Date.now(), { eventType: 'task' });
  broadcastUpdate();
  res.json({ success: true, task });
});

app.delete('/api/tasks/:id', (req, res) => {
  const index = tasks.findIndex((task) => task.id === req.params.id);
  if (index >= 0) tasks.splice(index, 1);
  broadcastUpdate();
  res.json({ success: true });
});

app.post('/api/ota/upload', (req, res) => {
  const { fileName, fileSize, version } = req.body;
  otaState.available = true;
  otaState.fileName = fileName || 'firmware.bin';
  otaState.fileSize = Number(fileSize || 0);
  otaState.version = version || `v${Date.now()}`;
  otaState.uploadedAt = Date.now();
  otaState.rollout = {
    active: false,
    progress: 0,
    success: 0,
    updating: 0,
    failed: 0,
    logs: []
  };
  pushRecentEvent('OTA-SERVER', `Firmware uploaded ${otaState.version}`, otaState.fileName, 'info', Date.now(), { eventType: 'ota' });
  broadcastUpdate();
  res.json({ success: true, ota: otaState });
});

app.post('/api/ota/deploy', (req, res) => {
  const devices = getDevicesList().filter((device) => {
    if (!Array.isArray(req.body.deviceIds) || req.body.deviceIds.length === 0) return true;
    return req.body.deviceIds.includes(device.id);
  });

  otaState.rollout.active = true;
  otaState.rollout.progress = 25;
  otaState.rollout.updating = devices.length;
  otaState.rollout.success = 0;
  otaState.rollout.failed = 0;
  otaState.rollout.logs = devices.map((device) => ({
    deviceId: device.id,
    status: 'Writing flash',
    progress: 25
  }));
  broadcastUpdate();
  res.json({ success: true, ota: otaState });
});

app.get('/*path', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const device of attackStats.devices.values()) {
    if (now - device.lastSeen > DEVICE_TIMEOUT_MS && device.status !== 'offline') {
      device.status = 'offline';
      device.running = false;
      device.activityState = 'Offline';
      changed = true;
    }
  }

  if (otaState.rollout.active) {
    otaState.rollout.progress = Math.min(100, otaState.rollout.progress + 15);
    otaState.rollout.logs = otaState.rollout.logs.map((log) => ({
      ...log,
      progress: Math.min(100, log.progress + 20),
      status: log.progress >= 80 ? 'Success' : log.progress >= 40 ? 'Writing flash' : 'Downloading'
    }));
    otaState.rollout.success = otaState.rollout.logs.filter((log) => log.progress >= 100).length;
    otaState.rollout.updating = otaState.rollout.logs.filter((log) => log.progress < 100).length;
    if (otaState.rollout.progress >= 100) {
      otaState.rollout.active = false;
      otaState.rollout.progress = 100;
      for (const device of attackStats.devices.values()) {
        if (device.status === 'online') device.firmwareVersion = otaState.version;
      }
    }
    changed = true;
  }

  updateSystemLoad();
  if (changed) broadcastUpdate();
}, 5000);

server.listen(PORT, () => {
  console.log('ESP Attack Dashboard Control Center');
  console.log(`Dashboard URL: http://localhost:${PORT}`);
  console.log(`MQTT broker: ${MQTT_BROKER_URL}:${MQTT_PORT}`);
});
