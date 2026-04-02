# ESP Protector Dashboard

This repo contains a defender-side dashboard for the ESP attack simulator. It watches the same MQTT traffic as the attacker dashboard, but presents it as a protection console with shield posture, target exposure, mitigation activity, and device health.

## Run locally

```bash
npm install
npm start
```

The dashboard starts on `http://localhost:3100` by default.

## Environment variables

- `PORT`
- `MQTT_BROKER_URL`
- `MQTT_PORT`
- `MQTT_ATTACK_TOPIC`
- `MQTT_HEARTBEAT_TOPIC`
- `MQTT_STATUS_TOPIC`
- `MQTT_CONTROL_TOPIC`
- `MQTT_PROTECTION_TOPIC`
- `DEVICE_TIMEOUT_MS`
- `HIGH_PRESSURE_RATE`
- `CRITICAL_PRESSURE_RATE`
