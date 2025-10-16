import asyncio
import struct
import serial_asyncio
from flask import Flask, render_template, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit
from datetime import datetime
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

UART_PORT = '/dev/ttyUSB0'
UART_BAUDRATE = 115200
PACKET_SIZE = 64
START_SEQ = bytes([0x01, 0x02, 0x03, 0x04])

# Команды
CMD_WAIT_SYNC = 0x3A
CMD_GET_DATA = 0x3B
CMD_GET_IGNITION_MAP = 0x3C
CMD_MAP_DATA_PACKET = 0x3D
CMD_MAP_TRANSFER_COMPLETE = 0x3E
CMD_SEND_MAP_DATA = 0x3F

# Состояния работы
class ConnectionState:
    DISCONNECTED = 0
    WAIT_SYNC = 1
    SYNC_COMPLETE = 2
    MAP_REQUESTED = 3
    MAP_TRANSFER = 4
    READY_FOR_DATA = 5

# Глобальные переменные
current_data = {
    'rpm': 0,
    'throttle': 0,
    'spark_angle': 0,
    'voltage': 0,
    'timestamp': datetime.now().isoformat()
}

# Переменные для приема таблицы
ignition_map = [[0.0] * 32 for _ in range(32)]  # 32x32 таблица
map_transfer_active = False
map_transfer_progress = {} 
connection_state = ConnectionState.DISCONNECTED

# Flask приложение
app = Flask(__name__, static_folder='frontend/static', static_url_path='/static')
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, cors_allowed_origins="*")

def calc_crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = (crc << 1) ^ 0x1021
            else:
                crc <<= 1
            crc &= 0xFFFF
    return crc

def decode_xyz_payload(payload: bytes, command: int) -> tuple[int, float, int, float, float]:
    if len(payload) < 18:
        print(f"Payload too short for data: {len(payload)} bytes")
        return 0, 0.0, 0, 0.0, 0.0
        
    rpm = payload[0] + payload[1] * 256
    uoz = struct.unpack('<f', payload[2:6])[0]
    delay_us = payload[6] + payload[7] * 256 + payload[8] * 65536 + payload[9] * 16777216
    tps = struct.unpack('<f', payload[10:14])[0]
    measured_zvs_voltage = struct.unpack('<f', payload[14:18])[0]
    return rpm, round(uoz, 2), delay_us, tps, round(measured_zvs_voltage, 2)

def build_uart_packet(command: int, payload_data: bytes = None) -> bytes:
    DATA_PAYLOAD = 55
    RESP_OK = 0x00
    
    if payload_data is None:
        payload_data = bytes([0] * DATA_PAYLOAD)
    else:
        payload_data = payload_data.ljust(DATA_PAYLOAD, b'\x00')
    
    buffer_crc = bytes([command, RESP_OK, 0]) + payload_data
    crc_val = calc_crc16(buffer_crc)
    crc_hi = (crc_val >> 8) & 0xFF
    crc_lo = crc_val & 0xFF

    packet = struct.pack(f'>4sBBB{DATA_PAYLOAD}sBB', START_SEQ, command, RESP_OK, 0, payload_data, crc_hi, crc_lo)
    return packet

def decode_map_row(payload: bytes) -> None:
    global ignition_map, map_transfer_active, map_transfer_progress
    
    if len(payload) < 1:
        print(f"Map row packet too short: {len(payload)} bytes")
        return
    
    row_num = payload[0]
    print(f"Receiving map data for row {row_num}, payload length: {len(payload)}")
    
    # Данные строки начинаются со 2-го байта
    row_data = payload[1:]
    
    # Определяем начальный индекс на основе уже полученных данных для этой строки
    if row_num not in map_transfer_progress:
        map_transfer_progress[row_num] = 0
    
    start_index = map_transfer_progress[row_num]
    
    # Декодируем значения float из данных
    values_count = len(row_data) // 4
    for i in range(values_count):
        if (start_index + i) < 32:  # Не превышаем размер строки
            value = struct.unpack('<f', row_data[i*4:i*4+4])[0]
            ignition_map[row_num][start_index + i] = round(value, 2)
    
    # Обновляем прогресс для этой строки
    map_transfer_progress[row_num] += values_count
    
    print(f"Received {values_count} values for row {row_num} starting from index {start_index}")

def complete_map_transfer():
    global ignition_map, map_transfer_active, connection_state, map_transfer_progress
    
    print("Map transfer completed")
    
    # Сбрасываем прогресс
    map_transfer_progress = {}
    
    # Сохраняем в файл в текущей директории
    map_file_path = os.path.join(BASE_DIR, 'frontend/static/ignition_map.json')
    with open(map_file_path, 'w') as f:
        json.dump(ignition_map, f, indent=2)
    
    print(f"Ignition map saved: 32x32 values at {map_file_path}")
    map_transfer_active = False
    connection_state = ConnectionState.READY_FOR_DATA
    
    # Отправляем обновление через WebSocket
    socketio.emit('map_updated', {'map': ignition_map})



class UARTProtocol(asyncio.Protocol):
    def __init__(self):
        self.buffer = bytearray()
        self.transport = None
        self.connection_ready = asyncio.Event()
        self.waiting_for_packet = False
        self.expected_packet_start = None

    def connection_made(self, transport):
        global connection_state
        self.transport = transport
        print("UART connection established")
        self.connection_ready.set()
        connection_state = ConnectionState.WAIT_SYNC

    def data_received(self, data):
        self.buffer.extend(data)
        while True:
            if not self.waiting_for_packet:
                found = self._find_start_sequence()
                if not found:
                    break
            if self.waiting_for_packet:
                if len(self.buffer) < PACKET_SIZE:
                    break
                self._read_complete_packet()
                if len(self.buffer) < PACKET_SIZE:
                    break

    def _find_start_sequence(self):
        pos_xyz = self.buffer.find(START_SEQ)
        
        if pos_xyz != -1:
            if pos_xyz > 0:
                del self.buffer[:pos_xyz]
            self.expected_packet_start = START_SEQ
            self.waiting_for_packet = True
            return True
        else:
            if len(self.buffer) > 64:
                del self.buffer[:10]
            else:
                self.buffer.clear()
            return False

    def _read_complete_packet(self):
        global current_data, connection_state
        
        if len(self.buffer) < PACKET_SIZE:
            return
            
        packet = bytes(self.buffer[:PACKET_SIZE])
        if packet[:4] != self.expected_packet_start:
            self.waiting_for_packet = False
            self.expected_packet_start = None
            del self.buffer[0]
            self._find_start_sequence()
            return
            
        calc_crc = calc_crc16(packet[4:62])
        recv_crc = (packet[62] << 8) | packet[63]
        if calc_crc == recv_crc:
            del self.buffer[:PACKET_SIZE]
            command = packet[4]
            payload_len = packet[6]

            print(f"Received command: 0x{command:02X}, payload_len: {payload_len}")

            if self.expected_packet_start == START_SEQ:
                if command == CMD_WAIT_SYNC:
                    print("Sync response received")
                    connection_state = ConnectionState.SYNC_COMPLETE
                    
                elif command == CMD_GET_DATA:
                    if payload_len >= 18:
                        x, y, z, ax, ay = decode_xyz_payload(packet[7:7+55], command)
                        print(f"Live data: RPM={x}, UOZ={y}, Delay={z}, TPS={ax}, Voltage={ay}")
                        
                        current_data['rpm'] = x
                        current_data['throttle'] = ax
                        current_data['spark_angle'] = y
                        current_data['voltage'] = ay
                        current_data['timestamp'] = datetime.now().isoformat()

                        # Отправляем данные через WebSocket
                        socketio.emit('data_update', current_data)
                    else:
                        print(f"Data packet too short: {payload_len} bytes")
                            
                elif command == CMD_MAP_DATA_PACKET:
                    print(f"Processing map data packet, payload_len: {payload_len}")
                    print(packet.hex())
                    if payload_len > 0 and payload_len <= 55:
                        decode_map_row(packet[7:7+payload_len])
                    else:
                        print(f"Invalid map payload length: {payload_len}")
                    
                elif command == CMD_MAP_TRANSFER_COMPLETE:
                    print("Map transfer completed")
                    complete_map_transfer()
                else:
                    print(f"Unknown command received: 0x{command:02X}")

            self.waiting_for_packet = False
            self.expected_packet_start = None
            
            if len(self.buffer) > 0:
                self._find_start_sequence()
        else:
            print("CRC error")
            del self.buffer[0]
            self.waiting_for_packet = False
            self.expected_packet_start = None
            self._find_start_sequence()

    def send(self, data: bytes):
        if self.transport:
            self.transport.write(data)
            print(f"Sent command: 0x{data[4]:02X}")
        else:
            print("UART transport not connected")

async def uart_reader():
    loop = asyncio.get_running_loop()
    protocol_instance = UARTProtocol()
    await serial_asyncio.create_serial_connection(loop, lambda: protocol_instance, UART_PORT, baudrate=UART_BAUDRATE)
    return protocol_instance

def pack_map_row(row_num: int, start_index: int, values: list[float]) -> bytes:
    # Максимум значений в пакете по размеру: DATA_PAYLOAD=55 байт, минус 1 байт номера строки
    # В каждой float 4 байта, максимум (55-1)//4=13 значений за раз
    max_values_per_packet = 13  
    values = values[:max_values_per_packet]
    
    payload = bytes([row_num])  # Номер строки
    for v in values:
        payload += struct.pack('<f', v)
    
    # Если payload короче 55 байт, pad нулями
    payload = payload.ljust(55, b'\x00')
    
    # 0 - зарезервированные байты по структуре, под отправку положим 0
    packet = struct.pack('>4sBBB55sBB', START_SEQ, CMD_SEND_MAP_DATA, 0x00, 0, payload, 0, 0)
    
    # Расчёт CRC по пакету начиная с bytes 4 до 62 (без CRC)
    crc_val = calc_crc16(packet[4:62])
    crc_hi = (crc_val >> 8) & 0xFF
    crc_lo = crc_val & 0xFF
    
    full_packet = packet[:62] + bytes([crc_hi, crc_lo])
    return full_packet

async def send_ignition_map_over_uart(protocol: UARTProtocol):
    print("Sending ignition map over UART...")
    
    # Загружаем карту из файла
    map_path = os.path.join(BASE_DIR, 'frontend/static/ignition_map.json')
    try:
        with open(map_path, 'r') as f:
            ignition_map_local = json.load(f)
    except Exception as e:
        print(f"Failed to load ignition_map.json: {e}")
        return
    
    # Поочерёдно отправляем данные строки порциями (до 13 значений на пакет)
    for row_num, row in enumerate(ignition_map_local):
        total_values = len(row)
        sent_values = 0
        while sent_values < total_values:
            chunk = row[sent_values:sent_values + 13]
            packet = pack_map_row(row_num, sent_values, chunk)
            protocol.send(packet)
            sent_values += len(chunk)
            await asyncio.sleep(0.05)  # пауза между пакетами, чтобы не спамить слишком быстро
    
    # Отправляем команду завершения передачи (повторяем CMD_MAP_TRANSFER_COMPLETE)
    print("Map data sending complete, sending transfer complete command...")
    packet_end = build_uart_packet(CMD_MAP_TRANSFER_COMPLETE)
    protocol.send(packet_end)
    print("Ignition map sent")

# Flask routes
@app.route('/')
@app.route('/main.html')
def index():
    return send_from_directory('.', 'frontend/templates/main.html')

@app.route('/src/main.js')
def serve_main_js():
    return send_from_directory('.', 'frontend/src/main.js')


@app.route('/ignition_map.json')
def serve_ignition_map():
    try:
        return app.send_static_file('ignition_map.json')
    except FileNotFoundError:
        return jsonify({"error": "Ignition map not found"}), 404

@app.route('/api/data')
def get_data():
    return jsonify(current_data)

# WebSocket handlers
@socketio.on('connect')
def handle_connect():
    print(f"WebSocket client connected: {request.sid}")
    # Отправляем текущие данные при подключении
    emit('data_update', current_data)
    emit('map_updated', {'map': ignition_map})

@socketio.on('disconnect')
def handle_disconnect():
    print(f"WebSocket client disconnected: {request.sid}")

@socketio.on('get_map')
def handle_get_map():
    global connection_state
    if connection_state == ConnectionState.READY_FOR_DATA:
        connection_state = ConnectionState.MAP_REQUESTED
        print("Map update requested via WebSocket")
        emit('map_updated', {'map': ignition_map})

async def protocol_handler(protocol: UARTProtocol):
    global connection_state
    await protocol.connection_ready.wait()
    print("Starting protocol handler")
    
    # Шаг 1: Синхронизация
    print("Step 1: Synchronization")
    protocol.send(build_uart_packet(CMD_WAIT_SYNC))
    
    # Ждем синхронизации
    timeout_count = 0
    while connection_state != ConnectionState.SYNC_COMPLETE and timeout_count < 50:
        await asyncio.sleep(0.1)
        timeout_count += 1
    
    # Шаг 2: Запрос таблицы УОЗ
    print("Step 2: Request ignition map")
    connection_state = ConnectionState.MAP_REQUESTED
    protocol.send(build_uart_packet(CMD_GET_IGNITION_MAP))
    
    # Ждем завершения передачи таблицы
    print("Waiting for map transfer...")
    timeout_count = 0
    while connection_state != ConnectionState.READY_FOR_DATA and timeout_count < 300:
        await asyncio.sleep(0.1)
        timeout_count += 1
        
        if timeout_count % 20 == 0:
            print(f"Still waiting for map transfer... {timeout_count/10} seconds")
    
    if connection_state != ConnectionState.READY_FOR_DATA:
        print("Map transfer timeout after 30 seconds")
        return
    
    print('Богданчик')
    await send_ignition_map_over_uart(protocol)

    # Шаг 3: Циклический опрос данных
    print("Step 3: Start data polling")
    data_request_count = 0
    
    while True:
        protocol.send(build_uart_packet(CMD_GET_DATA))
        data_request_count += 1
        
        if data_request_count % 10 == 0:
            print(f"Data polling: {data_request_count} requests sent")
            
        await asyncio.sleep(0.1)

async def run_uart_tasks():
    protocol = await uart_reader()
    await protocol_handler(protocol)

def start_uart_tasks():
    asyncio.run(run_uart_tasks())

if __name__ == '__main__':
    import threading
    
    # Запускаем UART задачи в отдельном потоке
    uart_thread = threading.Thread(target=start_uart_tasks, daemon=True)
    uart_thread.start()
    
    # Запускаем Flask-SocketIO сервер
    socketio.run(app, host='localhost', port=8080, debug=False)