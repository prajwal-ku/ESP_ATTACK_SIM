# ESP8266 Attacker Node

This firmware is bundled with the dashboard repo so the simulator and dashboard can live together in one repository.

## Files

- `esp8266_attack.ino`: main firmware sketch
- `config.h`: Wi-Fi, broker, topic, and safety configuration

## Setup

1. Open the sketch in Arduino IDE.
2. Update `config.h` with your Wi-Fi credentials and preferred device ID.
3. Install `PubSubClient` and `ArduinoJson`.
4. Flash the sketch to your ESP8266.
