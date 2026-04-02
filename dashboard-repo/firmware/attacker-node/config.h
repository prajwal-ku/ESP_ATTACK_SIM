#ifndef CONFIG_H
#define CONFIG_H

#define WIFI_SSID "Prajwal's HP"
#define WIFI_PASSWORD "FG Prajwal"

#define MQTT_SERVER "broker.emqx.io"
#define MQTT_PORT 1883
#define MQTT_TOPIC_CONTROL "devices/control"
#define MQTT_TOPIC_ATTACK "attacks/count"
#define MQTT_TOPIC_STATUS "devices/status"
#define MQTT_TOPIC_HEARTBEAT "devices/heartbeat"

#define DEVICE_ID "ESP8266_01"

#define DEFAULT_TARGET "https://httpbin.org/get"
#define DEFAULT_RATE 10
#define DEFAULT_DURATION 0

#define MAX_RATE 100
#define MIN_RATE 1
#define MAX_DURATION 3600

#define HEARTBEAT_INTERVAL 30000
#define MQTT_RETRY_DELAY 2000
#define WIFI_TIMEOUT 20000
#define HTTP_TIMEOUT 3000

#endif
