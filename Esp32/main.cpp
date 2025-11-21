#include <WiFi.h>
#include <PubSubClient.h>

// --- Cấu hình Chân (Pin) ---
#define RUN_LED 2   
#define LED_PIN 16   
#define WARN_PIN 17  
#define SPE_PIN 5    

// --- Cấu hình WiFi & MQTT ---
const char* WIFI_SSID = "AD18A";
const char* WIFI_PASS = "201102201";

const char* MQTT_HOST = "192.168.137.1"; 
const uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "hoaggg";
const char* MQTT_PASSWD = "123456";

// Topic gửi dữ liệu lên
const char* PUB_TOPIC = "sensors";

WiFiClient net;
PubSubClient mqtt(net);

// --- Biến toàn cục ---
unsigned long tLast = 0;       // Biến đếm thời gian gửi dữ liệu (2s)
unsigned long lastBlink = 0;   // Biến đếm thời gian nháy đèn (200ms)
bool blinkState = false;       // Trạng thái nháy đèn
float currentLux = 0;          // Lưu giá trị ánh sáng hiện tại

// Hàm set chân cho gọn
inline void setPin(uint8_t pin, bool on){ digitalWrite(pin, on?HIGH:LOW); }

// Hàm kết nối WiFi
void ensureWifi(){
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long t0 = millis();
  Serial.print("Connecting WiFi");
  while (WiFi.status()!=WL_CONNECTED && millis()-t0<10000){ delay(300); Serial.print("."); }
  if (WiFi.status()==WL_CONNECTED) Serial.printf("\nIP: %s\n", WiFi.localIP().toString().c_str());
  else Serial.println("\nWiFi Connect Failed");
}

// Hàm kết nối MQTT
void ensureMqtt(){
  if (mqtt.connected()) return;
  // Đổi Client ID ngẫu nhiên để tránh xung đột
  String clientId = "ESP32_Light_Sys_" + String(random(0xffff), HEX);
  
  if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWD)) {
    Serial.println("MQTT Connected");
    
    // Chỉ Subscribe topic điều khiển ĐÈN 1 (LED_PIN)
    // Không subscribe Fan/Warn vì nó chạy tự động
    mqtt.subscribe("led", 1);
    mqtt.subscribe("devices/led/set", 1);
    
  } else {
    Serial.printf("MQTT Failed, rc=%d\n", mqtt.state());
    delay(2000);
  }
}

void onMqtt(char* topic, byte* payload, unsigned int len){
  bool on = (len>0 && (payload[0]=='1' || payload[0]=='o' || payload[0]=='O')); 

  if (strcmp(topic, "led")==0 || strcmp(topic, "devices/led/set")==0) {
    setPin(LED_PIN, on);
    mqtt.publish("esp32/led", on?"1":"0", false);
    Serial.printf("Manual Light (GPIO 16): %s\n", on ? "ON" : "OFF");
  }
}

void setup(){
  Serial.begin(115200);

  // Cấu hình chân
  pinMode(RUN_LED, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(WARN_PIN, OUTPUT); // Chân cảnh báo
  pinMode(SPE_PIN, OUTPUT);
  
  // Tắt hết ban đầu
  setPin(LED_PIN, false); 
  setPin(WARN_PIN, false); 
  setPin(SPE_PIN, false);

  // Kết nối
  WiFi.mode(WIFI_STA);
  ensureWifi();

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
}

void loop(){
  ensureWifi();
  ensureMqtt();
  mqtt.loop();

  // --- LOGIC 1: Tạo dữ liệu Random và Gửi (Mỗi 2 giây) ---
  if (millis() - tLast >= 2000){
    tLast = millis();

    // Nháy đèn trên mạch báo hiệu đang chạy
    digitalWrite(RUN_LED, HIGH); delay(50); digitalWrite(RUN_LED, LOW);

    // Random Ánh sáng (0 - 100)
    currentLux = (float)random(0, 101);

    // Gửi dữ liệu lên Server
    char msg[32];
    snprintf(msg, sizeof(msg), "%.1f", currentLux); // Chỉ gửi 1 số duy nhất
    mqtt.publish(PUB_TOPIC, msg, false);
    
    Serial.printf("Sent Lux: %.1f\n", currentLux);
  }

  // --- LOGIC 2: Xử lý Đèn Cảnh Báo (WARN_PIN - GPIO 17) ---
  // Kiểm tra giá trị ánh sáng hiện tại
  if (currentLux > 50) {
    // Nếu > 50: Nhấp nháy mỗi 200ms
    if (millis() - lastBlink > 200) {
      lastBlink = millis();
      blinkState = !blinkState; // Đảo trạng thái tắt/bật
      setPin(WARN_PIN, blinkState);
    }
  } else {
    // Nếu <= 50: Tắt hẳn đèn cảnh báo
    setPin(WARN_PIN, false);
    blinkState = false;
  }
}