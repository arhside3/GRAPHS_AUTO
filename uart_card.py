import asyncio
import struct
import serial_asyncio
from flask import Flask, render_template, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from datetime import datetime
import os
import threading

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

UART_PORT = '/dev/ttyUSB0'
UART_BAUDRATE = 115200
PACKET_SIZE = 64
START_SEQ = bytes([0x01, 0x02, 0x03, 0x04])

current_data = {
    'X': 0,
    'Y': 0, 
    'Z': 0,
    'AX': 0,
    'AY': 0,
    'AZ': 0,
    'LX': 0,
    'LY': 0,
    'LZ': 0,
    'timestamp': datetime.now().isoformat()
}

# Flask приложение
app = Flask(__name__, 
            static_folder='frontend/static',
            template_folder='frontend/templates')
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
    rpm = payload[0] + payload[1] * 256
    uoz = struct.unpack('<f', payload[2:6])[0]
    delay_us = payload[6] + payload[7] * 256 + payload[8] * 65536 + payload[9] * 16777216
    tps = struct.unpack('<f', payload[10:14])[0]
    measured_zvs_voltage = struct.unpack('<f', payload[14:18])[0]
    return rpm, round(uoz, 2), delay_us, tps, round(measured_zvs_voltage, 2)

def build_uart_packet_xyz(command: int) -> bytes:
    DATA_PAYLOAD = 55
    RESP_OK = 0x00
    
    payload = bytes([0] * DATA_PAYLOAD)
    buffer_crc = bytes([command, RESP_OK, 0]) + payload
    crc_val = calc_crc16(buffer_crc)
    crc_hi = (crc_val >> 8) & 0xFF
    crc_lo = crc_val & 0xFF

    packet = struct.pack(f'>4sBBB{DATA_PAYLOAD}sBB', START_SEQ, command, RESP_OK, 0, payload, crc_hi, crc_lo)
    return packet

class UARTProtocol(asyncio.Protocol):
    def __init__(self):
        self.buffer = bytearray()
        self.transport = None
        self.connection_ready = asyncio.Event()
        self.waiting_for_packet = False
        self.expected_packet_start = None

    def connection_made(self, transport):
        self.transport = transport
        print("UART connection established")
        self.connection_ready.set()

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
        
        positions = []
        if pos_xyz != -1:
            positions.append((pos_xyz, START_SEQ))

        if not positions:
            if len(self.buffer) > 64:
                del self.buffer[:10]
            else:
                print("No start sequence found. Clearing buffer")
                self.buffer.clear()
            return False
            
        pos, seq = min(positions, key=lambda x: x[0])
        if pos > 0:
            del self.buffer[:pos]
        self.expected_packet_start = seq
        self.waiting_for_packet = True
        return True

    def _read_complete_packet(self):
        global current_data
        
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

            if self.expected_packet_start == START_SEQ:
                x, y, z, ax, ay = decode_xyz_payload(packet[7:7+55], command)
                print(f"Decoded: X={x}, Y={y}, Z={z}, AX={ax}, AY={ay}")
                
                # Обновляем данные для графиков
                current_data['X'] = x
                current_data['Y'] = y
                current_data['Z'] = z
                current_data['AX'] = ax
                current_data['AY'] = ay
                current_data['timestamp'] = datetime.now().isoformat()

                # Отправляем данные через WebSocket
                socketio.emit('data_update', current_data)

            self.waiting_for_packet = False
            self.expected_packet_start = None
            
            if len(self.buffer) > 0:
                self._find_start_sequence()
        else:
            del self.buffer[0]
            self.waiting_for_packet = False
            self.expected_packet_start = None
            self._find_start_sequence()

    def send(self, data: bytes):
        if self.transport:
            self.transport.write(data)
        else:
            print("UART transport not connected")

async def uart_reader():
    loop = asyncio.get_running_loop()
    protocol_instance = UARTProtocol()
    await serial_asyncio.create_serial_connection(loop, lambda: protocol_instance, UART_PORT, baudrate=UART_BAUDRATE)
    return protocol_instance

async def periodic_send(protocol: UARTProtocol):
    await protocol.connection_ready.wait()
    print("Starting periodic UART send")
    
    while True:
        protocol.send(build_uart_packet_xyz(0x3A))
        await asyncio.sleep(0.1)
        protocol.send(build_uart_packet_xyz(0x3B))

# Flask routes
@app.route('/')
def index():
    return render_template('card.html')

@app.route('/card.html')
def serve_card():
    return render_template('card.html')

@app.route('/src/<path:filename>')
def serve_src_files(filename):
    return send_from_directory('frontend/src', filename)

@app.route('/static/<path:filename>')
def serve_static_files(filename):
    return send_from_directory('frontend/static', filename)

@app.route('/api/data')
def get_data():
    return jsonify(current_data)

# WebSocket handlers
@socketio.on('connect')
def handle_connect():
    print(f"WebSocket client connected")
    # Отправляем текущие данные при подключении
    emit('data_update', current_data)

@socketio.on('disconnect')
def handle_disconnect():
    print(f"WebSocket client disconnected")

async def run_uart_tasks():
    protocol = await uart_reader()
    await periodic_send(protocol)

def start_uart_tasks():
    asyncio.run(run_uart_tasks())

if __name__ == '__main__':
    import threading
    
    # Запускаем UART задачи в отдельном потоке
    uart_thread = threading.Thread(target=start_uart_tasks, daemon=True)
    uart_thread.start()
    
    # Запускаем Flask-SocketIO сервер
    socketio.run(app, host='0.0.0.0', port=8080, debug=False, allow_unsafe_werkzeug=True)