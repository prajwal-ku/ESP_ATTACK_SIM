# ESP Attack Dashboard

This repo contains the live dashboard that shows incoming simulated traffic, connected devices, attack rate, and recent incident activity.

## Run locally

```bash
npm install
npm start
```

The dashboard starts on `http://localhost:3000` by default.

## Environment variables

- `PORT`
- `MQTT_BROKER_URL`
- `MQTT_PORT`
- `MQTT_ATTACK_TOPIC`
- `MQTT_HEARTBEAT_TOPIC`
- `MQTT_STATUS_TOPIC`
- `MQTT_CONTROL_TOPIC`
- `DEVICE_TIMEOUT_MS`
