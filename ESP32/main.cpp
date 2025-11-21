#include <WiFi.h>
#include <Wire.h>
#include <DHT.h>
#include <BH1750.h>
#include <PubSubClient.h>
#include <ESPmDNS.h>

#define RUN_LED 2
#define LED_PIN 16
#define FAN_PIN 17
#define SPE_PIN 5
#define DHTPIN 4
#define DHTTYPE DHT22

const char* WIFI_SSID = "AD18A";
const char* WIFI_PASS = "201102201";

const char* MQTT_HOST = "192.168.137.1";
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "hoaggg";
const char* MQTT_PASSWD = "123456";
const char* PUB_TOPIC = "sensors";

WiFiClient net;
PubSubClient mqtt(net);

BH1750 lightMeter;
DHT dht(DHTPIN, DHTTYPE);

unsigned long tLast = 0;

inline void setPin(uint8_t pin, bool on){ digitalWrite(pin, on?HIGH:LOW); }

void ensureWifi(){
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  Serial.print("WiFi");
  while (WiFi.status()!=WL_CONNECTED && millis()-t0<10000){ delay(300); Serial.print("."); }
  if (WiFi.status()==WL_CONNECTED) Serial.printf("\nIP: %s\n", WiFi.localIP().toString().c_str());
  else Serial.println("\nWiFi fail");
}

bool initBH1750(){
  // thư viện BH1750 hỗ trợ begin(mode, addr)
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x23)) { Serial.println("BH1750 @0x23"); return true; }
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, 0x5C)) { Serial.println("BH1750 @0x5C"); return true; }
  Serial.println("BH1750 not found");
  return false;
}

void ensureMqtt(){
  if (mqtt.connected()) return;
  if (mqtt.connect("esp32", MQTT_USER, MQTT_PASSWD)) {
    // nhận cả topic rút gọn và dạng /set
    mqtt.subscribe("led", 1);
    mqtt.subscribe("fan", 1);
    mqtt.subscribe("spe", 1);
    mqtt.subscribe("devices/led/set", 1);
    mqtt.subscribe("devices/fan/set", 1);
    mqtt.subscribe("devices/spe/set", 1);
    Serial.println("MQTT connected & subscribed");
  } else {
    Serial.printf("MQTT connect failed, rc=%d\n", mqtt.state());
  }
}

void onMqtt(char* topic, byte* payload, unsigned int len){
  bool on = (len>0 && (payload[0]=='1' || payload[0]=='o' || payload[0]=='O')); 

  // Handle command và publish status feedback
  if      (strcmp(topic, "led")==0 || strcmp(topic, "devices/led/set")==0) {
    setPin(LED_PIN, on);
    // Publish ESP32 status để server biết là từ ESP32
    mqtt.publish("esp32/led", on?"1":"0", false);
  }
  else if (strcmp(topic, "fan")==0 || strcmp(topic, "devices/fan/set")==0) {
    setPin(FAN_PIN, on);
    mqtt.publish("esp32/fan", on?"1":"0", false);
  }
  else if (strcmp(topic, "spe")==0 || strcmp(topic, "devices/spe/set")==0) {
    setPin(SPE_PIN, on);
    mqtt.publish("esp32/spe", on?"1":"0", false);
  }

  Serial.printf("[MQTT] %s -> %d\n", topic, on?1:0);
}

void setup(){
  Serial.begin(115200);

  pinMode(RUN_LED, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(SPE_PIN, OUTPUT);
  setPin(LED_PIN,false); 
  setPin(FAN_PIN,false); 
  setPin(SPE_PIN,false);

  Wire.begin(21,22);         
  Wire.setClock(400000);      
  dht.begin();
  initBH1750();               

  WiFi.mode(WIFI_STA);
  ensureWifi();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
}

void loop(){
  ensureWifi();
  ensureMqtt();
  mqtt.loop();

  if (millis()-tLast >= 2000){
    tLast = millis();

    digitalWrite(RUN_LED, HIGH); delay(60); digitalWrite(RUN_LED, LOW);

    float t = dht.readTemperature();
    float h = dht.readHumidity();
    float lx = lightMeter.readLightLevel(); 
    if (!(lx>=0.0f && lx<100000.0f)) lx = NAN;

    char msg[64];
    snprintf(msg, sizeof(msg), "%.1f,%.1f,%.1f", t, h, lx);
    mqtt.publish(PUB_TOPIC, msg, false);
  }
}
