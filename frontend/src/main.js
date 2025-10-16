// В начале файла замените существующие константы:
const RPM_MIN = 300;
const RPM_MAX = 12000;
const TPS_MIN = 0;
const TPS_MAX = 100;

// Генерация RPM значений (32 значения)
const rpmHeaders = Array.from({length: 32}, (_, i) => 
    Math.round(RPM_MIN + i * (RPM_MAX - RPM_MIN) / 31)
);

// Генерация значений положения дросселя (32 значения)
const throttleValues = Array.from({length: 32}, (_, i) => 
    parseFloat((TPS_MIN + i * (TPS_MAX - TPS_MIN) / 31).toFixed(2))
);

// Инициализация данных угла опережения (32x32) - теперь будем загружать из UART
let sparkAngleData = [];
let ignitionMap = null; // Для хранения данных из STM32

let currentRPM = 900;
let currentThrottle = 50.0;
let currentPoint = null;
let isEditing = false;
let socket = null; // Изменяем ws на socket для Socket.IO
let axesHelper;

function createAxes() {
    if (axesHelper) scene.remove(axesHelper);

    const group = new THREE.Group();
    const axisSize = 10;

    // ===== Основные оси =====
    const makeLine = (from, to, color) => {
        const geom = new THREE.BufferGeometry().setFromPoints([from, to]);
        const mat = new THREE.LineBasicMaterial({ color: color, linewidth: 2 });
        return new THREE.Line(geom, mat);
    };

    // Оси
    group.add(makeLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(axisSize, 0, 0), 0xff4444)); // X - RPM
    group.add(makeLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, axisSize, 0), 0x44ff44)); // Y - УОЗ
    group.add(makeLine(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, axisSize), 0x4488ff)); // Z - TPS

    // ===== Подписи осей =====
    const addLabel = (text, color, pos) => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 128;
        ctx.fillStyle = color;
        ctx.font = 'bold 42px Segoe UI';
        ctx.fillText(text, 20, 70);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
        sprite.position.copy(pos);
        sprite.scale.set(1.5, 0.75, 1);
        group.add(sprite);
    };

    addLabel('RPM', '#ff4444', new THREE.Vector3(axisSize + 0.5, 0, 0));
    addLabel('УОЗ°', '#44ff44', new THREE.Vector3(0, axisSize + 0.5, 0));
    addLabel('TPS%', '#4488ff', new THREE.Vector3(0, 0, axisSize + 0.5));

    // ===== Стенки =====
    const wallMat = new THREE.MeshBasicMaterial({
        color: 0x334455,
        transparent: true,
        opacity: 0.2,
        side: THREE.DoubleSide
    });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(axisSize, axisSize), wallMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(axisSize / 2, 0, axisSize / 2);
    group.add(floor);

    const wallYZ = new THREE.Mesh(new THREE.PlaneGeometry(axisSize, axisSize), wallMat);
    wallYZ.rotation.y = Math.PI / 2;
    wallYZ.position.set(axisSize, axisSize / 2, axisSize / 2);
    group.add(wallYZ);

    const wallXY = new THREE.Mesh(new THREE.PlaneGeometry(axisSize, axisSize), wallMat);
    wallXY.position.set(axisSize / 2, axisSize / 2, 0);
    group.add(wallXY);

    // ===== Деления (по реальным данным таблицы) =====
    const lineMat = new THREE.LineBasicMaterial({ color: 0x666666, transparent: true, opacity: 0.7 });
    const font = 'bold 28px Segoe UI';
    const labelColor = '#cccccc';

    // ---- X (RPM) ----
    for (let i = 0; i < rpmHeaders.length; i++) {
        const x = (i / (rpmHeaders.length - 1)) * axisSize;

        // Вертикальные линии
        const geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(x, 0, 0),
            new THREE.Vector3(x, axisSize, 0)
        ]);
        const line = new THREE.Line(geom, lineMat);
        group.add(line);

        // Подписи RPM каждые 4 шага (чтобы не загромождать)
        if (i % 2 === 0 || i === rpmHeaders.length - 1) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 128;
            canvas.height = 64;
            ctx.fillStyle = labelColor;
            ctx.font = font;
            ctx.fillText(rpmHeaders[i], 10, 40);
            const tex = new THREE.CanvasTexture(canvas);
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
            sprite.scale.set(1.2, 0.6, 1);
            sprite.position.set(x, + 0.3, 0);
            group.add(sprite);
        }
    }

    // ---- Z (TPS) ----
    for (let i = 0; i < throttleValues.length; i++) {
        const z = (i / (throttleValues.length - 1)) * axisSize;

        // Линии вдоль X
        const geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, z),
            new THREE.Vector3(axisSize, 0, z)
        ]);
        const line = new THREE.Line(geom, lineMat);
        group.add(line);

        // Подписи TPS каждые 4 шага
        if (i % 2 === 0 || i === throttleValues.length - 1) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 128;
            canvas.height = 64;
            ctx.fillStyle = labelColor;
            ctx.font = font;
            ctx.fillText(throttleValues[i].toFixed(0), 10, 40);
            const tex = new THREE.CanvasTexture(canvas);
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
            sprite.scale.set(1.2, 0.6, 1);
            sprite.position.set(-0.8, -0.4, z);
            group.add(sprite);
        }
    }

    // ---- Y (УОЗ) ----
    const maxAngle = 90; // диапазон углов по оси Y
    const divisionsY = 10;
    for (let i = 0; i <= divisionsY; i++) {
        const y = (i / divisionsY) * axisSize;

        // Линии вдоль Z
        const geom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(axisSize, y, 0),
            new THREE.Vector3(axisSize, y, axisSize)
        ]);
        const line = new THREE.Line(geom, lineMat);
        group.add(line);

        // Подписи УОЗ
        const angleValue = Math.round((y / axisSize) * maxAngle);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.width = 128;
        canvas.height = 64;
        ctx.fillStyle = labelColor;
        ctx.font = font;
        ctx.fillText(angleValue, 10, 40);
        const tex = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
        sprite.scale.set(1.2, 0.6, 1);
        sprite.position.set(axisSize + 0.3, y, axisSize / 2); 
        group.add(sprite);
    }

    // ===== Контур куба =====
    const boxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(axisSize, axisSize, axisSize));
    const boxLines = new THREE.LineSegments(
        boxEdges,
        new THREE.LineBasicMaterial({ color: 0x777777, transparent: true, opacity: 0.4 })
    );
    boxLines.position.set(axisSize / 2, axisSize / 2, axisSize / 2);
    group.add(boxLines);

    axesHelper = group;
    scene.add(group);
}

function createAxisLabels() {
    // Создаем текстовые метки для осей
    const labels = [
        { text: 'RPM', position: [7, 0, 0], color: 0xff0000 },     // X - красный
        { text: 'УОЗ', position: [0, 7, 0], color: 0x00ff00 },     // Y - зеленый  
        { text: 'Дроссель', position: [0, 0, 7], color: 0x0000ff } // Z - синий
    ];
    
    labels.forEach(label => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 128;
        canvas.height = 64;
        
        context.fillStyle = `rgb(${label.color === 0xff0000 ? '255,0,0' : label.color === 0x00ff00 ? '0,255,0' : '0,0,255'})`;
        context.font = '24px Arial';
        context.fillText(label.text, 10, 40);
        
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture });
        const sprite = new THREE.Sprite(material);
        
        sprite.position.set(...label.position);
        sprite.scale.set(2, 1, 1);
        scene.add(sprite);
    });
}

// Функция для загрузки таблицы из файла (если существует)
async function loadIgnitionMap() {
    try {
        const response = await fetch('/static/ignition_map.json');
        if (response.ok) {
            ignitionMap = await response.json();
            console.log('Ignition map loaded from file');
            return true;
        }
    } catch (error) {
        console.log('No saved ignition map found, using default data');
    }
    return false;
}

// Функция для инициализации данных таблицы
function initializeSparkAngleData() {
    sparkAngleData = [];
    
    if (ignitionMap && ignitionMap.length === 32 && ignitionMap[0].length === 32) {
        // Используем данные из STM32
        for (let i = 0; i < throttleValues.length; i++) {
            const row = [throttleValues[i]];
            for (let j = 0; j < rpmHeaders.length; j++) {
                row.push(parseFloat(ignitionMap[i][j].toFixed(2)));
            }
            sparkAngleData.push(row);
        }
        console.log('Using STM32 ignition map data');
    } else {
        // Генерация резервных данных
        for (let i = 0; i < throttleValues.length; i++) {
            const row = [throttleValues[i]];
            for (let j = 0; j < rpmHeaders.length; j++) {
                const baseAngle = 10 + Math.sin(throttleValues[i] / 20) * 5 + Math.cos(rpmHeaders[j] / 400) * 8;
                row.push(Math.floor(baseAngle + Math.random() * 5));
            }
            sparkAngleData.push(row);
        }
        console.log('Using generated ignition map data');
    }
}

// WebSocket соединение через Socket.IO
function initWebSocket() {
    console.log('Initializing Socket.IO connection...');
    
    // Socket.IO автоматически подключается к текущему хосту
    socket = io();
    
    socket.on('connect', function() {
        console.log('Socket.IO connected successfully');
        // Запрашиваем обновление таблицы при подключении
        socket.emit('get_map');
    });
    
    socket.on('data_update', function(data) {
        console.log('Live data update received:', data);
        
        // Обновляем телеметрию
        currentRPM = data.rpm;
        currentThrottle = data.throttle;
        
        // Обновляем отображение текущей точки
        updateCurrentPoint();
    });
    
    socket.on('map_updated', function(data) {
        console.log('Map updated received:', data);
        // Получили обновленные данные таблицы
        ignitionMap = data.map;
        initializeSparkAngleData();
        createTable('spark-angle-table', rpmHeaders, sparkAngleData, 'spark');
        createFunctionTerrain();
        updateCurrentPoint();
        console.log('Ignition map updated via WebSocket');
    });
    
    socket.on('disconnect', function() {
        console.log('Socket.IO disconnected');
        // Пытаемся переподключиться через 3 секунды
        setTimeout(initWebSocket, 3000);
    });
    
    socket.on('connect_error', function(error) {
        console.error('Socket.IO connection error:', error);
    });
}

function getSparkAngleClass(value) {
    if (value <= 30) return 'spark-very-high';       
    if (value <= 40) return 'spark-high';
    if (value <= 50) return 'spark-high-medium';
    if (value <= 60) return 'spark-medium';
    if (value <= 70) return 'spark-low-medium';
    return 'spark-low';
}

function findClosestIndex(arr, value) {
    return arr.reduce((closest, current, index) => {
        return Math.abs(current - value) < Math.abs(arr[closest] - value) ? index : closest;
    }, 0);
}

function updateCurrentPoint() {
    const rpmIndex = findClosestIndex(rpmHeaders, currentRPM);
    const throttleIndex = findClosestIndex(throttleValues, currentThrottle);
    
    const angleValue = sparkAngleData[throttleIndex][rpmIndex + 1];
    
    document.getElementById('status-rpm').textContent = currentRPM;
    document.getElementById('status-throttle').textContent = currentThrottle.toFixed(2);
    document.getElementById('status-angle').textContent = angleValue;
    
    highlightTableCells('spark-angle-table', throttleIndex, rpmIndex);
    update3DPoint(throttleIndex, rpmIndex, angleValue);
}

function highlightTableCells(tableId, throttleIndex, rpmIndex) {
    const table = document.getElementById(tableId);
    const cells = table.querySelectorAll('td.current-point');
    cells.forEach(cell => cell.classList.remove('current-point'));
    
    const row = table.rows[throttleIndex + 1];
    if (row) {
        const cell = row.cells[rpmIndex + 1];
        if (cell) {
            cell.classList.add('current-point');
            cell.scrollIntoView({block: 'nearest', inline: 'nearest'});
        }
    }
}

function update3DPoint(throttleIndex, rpmIndex, angleValue) {
    if (currentPoint) {
        scene.remove(currentPoint);
        currentPoint.geometry.dispose();
        currentPoint.material.dispose();
    }

    const segments = 32;
    const axisSize = 10; // должен совпадать с тем, что в createFunctionTerrain
    const geometry = new THREE.SphereGeometry(0.15, 16, 16);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    currentPoint = new THREE.Mesh(geometry, material);

    // Пересчитываем координаты с учётом смещения графика в угол
    const x = (rpmIndex / (rpmHeaders.length - 1)) * axisSize; // от 0 до 10
    const z = (throttleIndex / (throttleValues.length - 1)) * axisSize; // от 0 до 10
    const y = angleValue / 10; // высота

    // Поверхность сдвинута так, что её угол (0,0) — в начале координат,
    // поэтому точку просто ставим в тех же координатах, без "-size/2"
    currentPoint.position.set(x, y, z);

    scene.add(currentPoint);

    updateAxisInfo(x, y, z, rpmIndex, throttleIndex, angleValue);
}

function updateAxisInfo(x, y, z, rpmIndex, throttleIndex, angleValue) {
    // Вычисляем реальные значения из индексов
    const realRPM = rpmHeaders[rpmIndex];
    const realThrottle = throttleValues[throttleIndex];
    const realAngle = angleValue;
    
    // Можно добавить отображение координат если нужно
    console.log(`3D Coordinates - X(RPM): ${realRPM}, Y(УОЗ): ${realAngle}°, Z(Дроссель): ${realThrottle}%`);
}

function createTable(tableId, headers, data, tableType) {
    const table = document.getElementById(tableId);
    table.innerHTML = '';
    
    const headerRow = document.createElement('tr');
    headerRow.className = 'table-header-row';
    
    const emptyHeader = document.createElement('th');
    emptyHeader.textContent = 'Дроссель/RPM';
    headerRow.appendChild(emptyHeader);
    
    headers.forEach(rpm => {
        const th = document.createElement('th');
        th.textContent = rpm;
        th.className = 'table-header-cell';
        headerRow.appendChild(th);
    });
    
    table.appendChild(headerRow);
    
    data.forEach((rowData, rowIndex) => {
        const row = document.createElement('tr');
        
        const throttleCell = document.createElement('td');
        throttleCell.textContent = rowData[0];
        throttleCell.className = 'map-values';
        row.appendChild(throttleCell);
        
        for (let i = 1; i < rowData.length; i++) {
            const cell = document.createElement('td');
            cell.textContent = rowData[i];
            
            if (tableType === 'spark') {
                cell.classList.add(getSparkAngleClass(rowData[i]));
            }
            
            cell.setAttribute('data-rpm-index', i - 1);
            cell.setAttribute('data-throttle-index', rowIndex);
            
            // Добавляем обработчик двойного клика
            cell.addEventListener('dblclick', handleCellDoubleClick);
            
            row.appendChild(cell);
        }
        
        table.appendChild(row);
    });
}

function handleCellDoubleClick(event) {
    if (isEditing) return;
    
    const cell = event.target;
    if (cell.tagName !== 'TD' || cell.classList.contains('map-values')) return;
    
    isEditing = true;
    
    const currentValue = cell.textContent;
    const rpmIndex = parseInt(cell.getAttribute('data-rpm-index'));
    const throttleIndex = parseInt(cell.getAttribute('data-throttle-index'));
    
    // Создаем input для редактирования
    const input = document.createElement('input');
    input.type = 'number';
    input.value = currentValue;
    input.min = '0';
    input.max = '50';
    input.style.width = '100%';
    input.style.height = '100%';
    input.style.border = 'none';
    input.style.background = 'transparent';
    input.style.textAlign = 'center';
    input.style.fontSize = 'inherit';
    input.style.color = 'inherit';
    
    // Заменяем содержимое ячейки на input
    cell.textContent = '';
    cell.appendChild(input);
    input.focus();
    input.select();
    
    function saveValue() {
        const newValue = parseInt(input.value);
        if (!isNaN(newValue) && newValue >= 0 && newValue <= 50) {
            updateTableValue(throttleIndex, rpmIndex, newValue);
        }
        isEditing = false;
    }
    
    function cancelEdit() {
        cell.textContent = currentValue;
        cell.classList.add(getSparkAngleClass(currentValue));
        isEditing = false;
    }
    
    input.addEventListener('blur', saveValue);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            saveValue();
        } else if (e.key === 'Escape') {
            cancelEdit();
        }
    });
}

function updateTableValue(throttleIndex, rpmIndex, value) {
    if (throttleIndex >= 0 && throttleIndex < sparkAngleData.length && 
        rpmIndex >= 0 && rpmIndex < sparkAngleData[0].length - 1) {
        sparkAngleData[throttleIndex][rpmIndex + 1] = value;
        
        // Обновляем таблицу
        const table = document.getElementById('spark-angle-table');
        const row = table.rows[throttleIndex + 1];
        if (row) {
            const cell = row.cells[rpmIndex + 1];
            if (cell) {
                cell.textContent = value;
                cell.className = '';
                cell.classList.add(getSparkAngleClass(value));
                
                // Снова добавляем обработчик двойного клика
                cell.addEventListener('dblclick', handleCellDoubleClick);
            }
        }
        
        // Перестраиваем 3D модель
        createFunctionTerrain();
        updateCurrentPoint();
    }
}

let scene, camera, renderer, controls, terrain;
let heightScale = 1;
let rotationSpeed = 0;
let wireframeVisible = false;

function initThreeJS() {
    const container = document.getElementById('terrain-container');
    const width = container.clientWidth;
    const height = container.clientHeight;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a2a3a);

    camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.set(15, 10, 15);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0x404040);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Создаем оси и поверхность
    createAxes();
    createFunctionTerrain();

    window.addEventListener('resize', () => {
        const width = container.clientWidth;
        const height = container.clientHeight;

        camera.aspect = width / height;
        camera.updateProjectionMatrix();

        renderer.setSize(width, height);
    });

    updateCurrentPoint();
    
    animate();
}

function createFunctionTerrain() {
    if (terrain) {
        scene.remove(terrain);
        terrain.geometry.dispose();
        terrain.material.dispose();
        terrain = null;
    }

    const segmentsX = rpmHeaders.length;
    const segmentsY = throttleValues.length;
    const axisSize = 10;

    const geometry = new THREE.PlaneGeometry(axisSize, axisSize, segmentsX - 1, segmentsY - 1);
    const vertices = geometry.attributes.position.array;
    const colors = [];
    const color = new THREE.Color();

    for (let i = 0; i < vertices.length; i += 3) {
        const x = vertices[i];
        const y = vertices[i + 1];

        const rpmIdx = Math.round((x + axisSize / 2) / axisSize * (segmentsX - 1));
        const thrIdx = (segmentsY - 1) - Math.round((y + axisSize / 2) / axisSize * (segmentsY - 1));

        let angle = 0;
        if (thrIdx >= 0 && thrIdx < sparkAngleData.length && rpmIdx >= 0 && rpmIdx < sparkAngleData[0].length - 1)
            angle = sparkAngleData[thrIdx][rpmIdx + 1];

        vertices[i + 2] = angle / 10;

        // Цветовая шкала с 6 уровнями
        if (angle <= 30) color.set('#00ff00');      // очень зелёный
        else if (angle <= 40) color.set('#66ff00'); // зелёный
        else if (angle <= 50) color.set('#ccff33'); // жёлто-зелёный
        else if (angle <= 60) color.set('#ffff00'); // жёлтый
        else if (angle <= 70) color.set('#ff9900'); // оранжевый
        else color.set('#ff0000');                  // красный

        colors.push(color.r, color.g, color.b);
    }

    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({
        vertexColors: true,
        wireframe: wireframeVisible,
        side: THREE.DoubleSide,
        flatShading: false
    });

    terrain = new THREE.Mesh(geometry, material);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(axisSize / 2, 0, axisSize / 2);

    scene.add(terrain);
}

function animate() {
    requestAnimationFrame(animate);

    if (rotationSpeed > 0 && terrain) {
        terrain.rotation.y += rotationSpeed / 1000;
    }

    controls.update();
    renderer.render(scene, camera);
}

function initControls() {
    document.getElementById('reset-view').addEventListener('click', () => {
        controls.reset();
        camera.position.set(15, 10, 15);

        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;

        const axisSize = 10; 
        controls.target.set(axisSize / 2, axisSize / 2, axisSize / 2);
        controls.update();
    });

    document.getElementById('toggle-wireframe').addEventListener('click', () => {
        wireframeVisible = !wireframeVisible;
        terrain.material.wireframe = wireframeVisible;
    });

    document.getElementById('change-color').addEventListener('click', () => {
        const colors = [0x3498db, 0xe74c3c, 0x2ecc71, 0xf39c12, 0x9b59b6];
        const randomColor = colors[Math.floor(Math.random() * colors.length)];
        terrain.material.color.setHex(randomColor);
    });

    document.getElementById('reset-values').addEventListener('click', () => {
        // Сброс к исходным значениям
        for (let i = 0; i < throttleValues.length; i++) {
            for (let j = 0; j < rpmHeaders.length; j++) {
                const baseAngle = 10 + Math.sin(throttleValues[i] / 20) * 5 + Math.cos(rpmHeaders[j] / 400) * 8;
                sparkAngleData[i][j + 1] = Math.floor(baseAngle + Math.random() * 5);
            }
        }
        
        createTable('spark-angle-table', rpmHeaders, sparkAngleData, 'spark');
        createFunctionTerrain();
        updateCurrentPoint();
    });

    // Обработчики для кнопок управления
    document.getElementById('refresh').addEventListener('click', () => {
        // Запрашиваем обновление таблицы
        if (socket && socket.connected) {
            socket.emit('get_map');
            alert('Запрос на обновление таблицы отправлен');
        } else {
            alert('Socket.IO соединение не установлено');
        }
    });

    document.getElementById('send').addEventListener('click', () => {
        alert('Данные отправлены');
    });

    document.getElementById('burn').addEventListener('click', () => {
        alert('Данные записаны');
    });

    document.getElementById('import').addEventListener('click', () => {
        alert('Импорт данных');
    });

    document.getElementById('export').addEventListener('click', () => {
        alert('Экспорт данных');
    });
}

// Основная функция инициализации
async function initializeApp() {
    // Загружаем таблицу зажигания
    await loadIgnitionMap();
    
    // Инициализируем данные
    initializeSparkAngleData();
    
    // Создаем таблицу
    createTable('spark-angle-table', rpmHeaders, sparkAngleData, 'spark');
    
    // Инициализируем 3D сцену и управление
    initThreeJS();
    initControls();
    initWebSocket();
}

window.addEventListener('load', initializeApp);