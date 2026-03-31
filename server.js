const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mqtt = require('mqtt');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MQTT Configuration
const MQTT_BROKER = 'mqtt://broker.emqx.io'; // Free public broker
const MQTT_PORT = 1883;
const ATTACK_TOPIC = 'attacks/count';
const CONTROL_TOPIC = 'esp/control';

// Store attack statistics
let attackStats = {
  totalAttacks: 0,
  devices: new Map(), // deviceId -> {count, lastAttack}
  recentAttacks: [], // Store last 50 attacks
  attacksPerSecond: 0,
  attackHistory: [] // For graphing
};

let attackTimestamps = [];

// Connect to MQTT
const mqttClient = mqtt.connect(`${MQTT_BROKER}:${MQTT_PORT}`);

mqttClient.on('connect', () => {
  console.log('Connected to MQTT broker');
  mqttClient.subscribe(ATTACK_TOPIC, (err) => {
    if (!err) console.log(`Subscribed to ${ATTACK_TOPIC}`);
  });
});

mqttClient.on('message', (topic, message) => {
  if (topic === ATTACK_TOPIC) {
    try {
      const data = JSON.parse(message.toString());
      handleAttack(data);
    } catch (e) {
      console.error('Error parsing attack data:', e);
    }
  }
});

function handleAttack(data) {
  const { deviceId, timestamp, type, target } = data;
  const now = Date.now();
  
  // Update total attacks
  attackStats.totalAttacks++;
  
  // Update device stats
  if (!attackStats.devices.has(deviceId)) {
    attackStats.devices.set(deviceId, { count: 0, lastAttack: now, type: 'Unknown' });
  }
  const device = attackStats.devices.get(deviceId);
  device.count++;
  device.lastAttack = now;
  device.type = type;
  
  // Add to recent attacks
  const attack = {
    id: attackStats.totalAttacks,
    deviceId,
    timestamp: now,
    time: new Date(now).toLocaleTimeString(),
    type,
    target
  };
  
  attackStats.recentAttacks.unshift(attack);
  if (attackStats.recentAttacks.length > 50) {
    attackStats.recentAttacks.pop();
  }
  
  // Calculate attacks per second
  attackTimestamps.push(now);
  attackTimestamps = attackTimestamps.filter(ts => now - ts < 1000);
  attackStats.attacksPerSecond = attackTimestamps.length;
  
  // Update history for graph (keep last 60 seconds)
  attackStats.attackHistory.push({ time: now, count: attackStats.attacksPerSecond });
  if (attackStats.attackHistory.length > 60) {
    attackStats.attackHistory.shift();
  }
  
  // Emit to all connected clients
  io.emit('attack-update', {
    totalAttacks: attackStats.totalAttacks,
    attacksPerSecond: attackStats.attacksPerSecond,
    recentAttack: attack,
    devices: Array.from(attackStats.devices.entries()).map(([id, stats]) => ({
      id,
      count: stats.count,
      lastAttack: stats.lastAttack,
      type: stats.type
    })),
    history: attackStats.attackHistory
  });
}

// Send command to ESP8266 devices
app.post('/api/control', express.json(), (req, res) => {
  const { action, target, rate, duration } = req.body;
  
  const command = {
    action,
    target: target || 'https://httpbin.org/get',
    rate: rate || 10,
    duration: duration || 0,
    timestamp: Date.now()
  };
  
  mqttClient.publish(CONTROL_TOPIC, JSON.stringify(command));
  console.log('Command sent:', command);
  res.json({ success: true, command });
});

// Serve static files
app.use(express.static('public'));

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dashboard running on http://localhost:${PORT}`);
});