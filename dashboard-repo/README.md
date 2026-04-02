# ESP Attack Dashboard

This repo now combines the live dashboard and the ESP8266 attacker firmware in one place.

## Included components

- `server.js` and `public/`: the live traffic dashboard and control surface
- `firmware/attacker-node/esp8266_attack.ino`: the ESP8266 simulator sketch
- `firmware/attacker-node/config.h`: Wi-Fi, broker, topic, and safety settings for the sketch

## Run locally

```bash
npm install
npm start
```

The dashboard starts on `http://localhost:3000` by default.

## Firmware setup

1. Open `firmware/attacker-node/esp8266_attack.ino` in Arduino IDE.
2. Update `firmware/attacker-node/config.h` with your Wi-Fi credentials and preferred device ID.
3. Install `PubSubClient` and `ArduinoJson`.
4. Flash the sketch to your ESP8266.

## Environment variables

- `PORT`
- `MQTT_BROKER_URL`
- `MQTT_PORT`
- `MQTT_ATTACK_TOPIC`
- `MQTT_HEARTBEAT_TOPIC`
- `MQTT_STATUS_TOPIC`
- `MQTT_CONTROL_TOPIC`
- `DEVICE_TIMEOUT_MS`
