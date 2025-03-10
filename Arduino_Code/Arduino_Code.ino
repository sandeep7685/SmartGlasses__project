#include "arduino_secrets.h"

#include <WiFi.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>
#include "PubSubClient.h"

#define SECRET_OPTIONAL_PASSWORD "keerthana"
#define SECRET_SSID "OnePlus Nord 2T"
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define SCREEN_ADDRESS 0x3C
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

const char* ssid = SECRET_SSID;
const char* password = SECRET_OPTIONAL_PASSWORD;
const char* mqttServer = "broker.emqx.io";
int port = 1883;
char clientId[50];

String DayTime = "N/A";
String TemperatureWeather = "N/A";

const int MAX_NOTIFICATIONS = 10;
String notificationQueue[MAX_NOTIFICATIONS];
int queueStart = 0;
int queueEnd = 0;

String currentNotification = "";
int scrollOffset = 0;
unsigned long lastScrollTime = 0;
unsigned long displayStartTime = 0;
const int scrollSpeed = 250;
const int minDisplayTime = 5000;
bool isScrolling = false;
bool hasScrolledThrough = false;
bool isNotificationActive = false;

WiFiClient espClient;
PubSubClient client(espClient);

void wifiConnect() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.print(".");
  }
}

void mqttReconnect() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");
    long r = random(1000);
    sprintf(clientId, "clientId-%ld", r);
    if (client.connect(clientId)) {
      Serial.print(clientId);
      Serial.println(" connected");
      client.subscribe("flutter/weather_data");
      client.subscribe("flutter/notification");
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

void enqueueNotification(String notif) {
  if ((queueEnd + 1) % MAX_NOTIFICATIONS == queueStart) {
    queueStart = (queueStart + 1) % MAX_NOTIFICATIONS;
  }
  notificationQueue[queueEnd] = notif;
  queueEnd = (queueEnd + 1) % MAX_NOTIFICATIONS;
}

String dequeueNotification() {
  if (queueStart == queueEnd) {
    return "";
  }
  String notif = notificationQueue[queueStart];
  queueStart = (queueStart + 1) % MAX_NOTIFICATIONS;
  return notif;
}

void updateDisplay() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);

  if (!isNotificationActive) {
    display.setCursor(0, 0);
    display.println(DayTime);
    display.setCursor(0, 16);
    display.println(TemperatureWeather);
    if (queueStart != queueEnd) {
      currentNotification = dequeueNotification();
      isNotificationActive = true;
      scrollOffset = 0;
      hasScrolledThrough = false;
      displayStartTime = millis();
    }
  }

  if (isNotificationActive && currentNotification != "") {
    display.setCursor(0, 0);
    display.println("Notification:");
    int maxCharsPerLine = 21;
    int numLines = (currentNotification.length() + maxCharsPerLine - 1) / maxCharsPerLine;
    int textHeight = numLines * 16;
    for (int i = 0; i < numLines; i++) {
      int y = 16 + (i * 16) - scrollOffset;
      if (y >= 16 && y < SCREEN_HEIGHT) {
        display.setCursor(0, y);
        int endIndex = min((i + 1) * maxCharsPerLine, (int)currentNotification.length());
        display.println(currentNotification.substring(i * maxCharsPerLine, endIndex));
      }
    }
    if (textHeight > SCREEN_HEIGHT - 16) {
      isScrolling = true;
      if (millis() - lastScrollTime > scrollSpeed) {
        scrollOffset++;
        lastScrollTime = millis();
        if (scrollOffset > textHeight - (SCREEN_HEIGHT - 16)) {
          hasScrolledThrough = true;
          isScrolling = false;
        }
      }
    } else {
      hasScrolledThrough = true;
    }
    if (hasScrolledThrough && millis() - displayStartTime > minDisplayTime) {
      isNotificationActive = false;
      currentNotification = "";
    }
  }
  display.display();
}

void callback(char* topic, byte* message, unsigned int length) {
  Serial.print("Message arrived on topic: ");
  Serial.print(topic);
  Serial.print(". Message: ");
  String stMessage;
  for (int i = 0; i < length; i++) {
    Serial.print((char)message[i]);
    stMessage += (char)message[i];
  }
  Serial.println();
  if (String(topic) == "flutter/weather_data") {
    StaticJsonDocument<200> doc;
    DeserializationError error = deserializeJson(doc, stMessage);
    if (!error) {
      DayTime = doc["DayDateTime"].as<String>();
      TemperatureWeather = doc["TemperatureWeather"].as<String>();
    }
  } else if (String(topic) == "flutter/notification") {
    enqueueNotification(stMessage);
  }
  updateDisplay();
}

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, SCREEN_ADDRESS)) {
    Serial.println(F("SSD1306 allocation failed"));
    for (;;);
  }
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("Connecting...");
  display.display();
  Serial.print("Connecting to ");
  Serial.println(ssid);
  wifiConnect();
  Serial.println("WiFi connected");
  client.setServer(mqttServer, port);
  client.setCallback(callback);
  updateDisplay();
}

void loop() {
  if (!client.connected()) {
    mqttReconnect();
  }
  client.loop();
  updateDisplay();
}