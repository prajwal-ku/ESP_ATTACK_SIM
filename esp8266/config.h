#ifndef CONFIG_H
#define CONFIG_H

// ==============================
// WIFI CONFIGURATION
// ==============================
// Fix: Using escaped apostrophe or alternative representation
#define WIFI_SSID "Prajwal\'s HP"     // Escaped apostrophe
// Alternative if above doesn't work: #define WIFI_SSID "Prajwal's HP"
#define WIFI_PASSWORD "FG Prajwal"

// ==============================
// MQTT CONFIGURATION
// ==============================
#define MQTT_SERVER "broker.hivemq.com"
#define MQTT_PORT 1883
#define MQTT_TOPIC_CONTROL "esp/control"    // Topic for receiving commands
#define MQTT_TOPIC_ATTACK "attacks/count"   // Topic for sending attack data
#define MQTT_TOPIC_STATUS "devices/status"  // Topic for device status
#define MQTT_TOPIC_HEARTBEAT "devices/heartbeat" // Topic for heartbeat

#define DEVICE_ID "ESP8266_01"

// ==============================
// ATTACK TARGET
// ==============================
#define DEFAULT_TARGET "https://httpbin.org/get"

// ==============================
// DEFAULT SETTINGS
// ==============================
#define DEFAULT_RATE 10     // Changed from 2 to 10 for better testing
#define DEFAULT_DURATION 0  // 0 = unlimited

// ==============================
// SAFETY LIMITS
// ==============================
#define MAX_RATE 100        // Changed from 5 to 100 for flexibility
#define MIN_RATE 1
#define MAX_DURATION 3600   // Max 1 hour in seconds

// ==============================
// TIMING SETTINGS (milliseconds)
// ==============================
#define HEARTBEAT_INTERVAL 30000  // 30 seconds
#define MQTT_RETRY_DELAY 2000     // 2 seconds
#define WIFI_TIMEOUT 20000        // 20 seconds
#define HTTP_TIMEOUT 3000         // 3 seconds

// ==============================
// DEBUG SETTINGS
// ==============================
#define ENABLE_SERIAL true
#define DEBUG_LEVEL 2  // 0=none, 1=errors, 2=all

#endif