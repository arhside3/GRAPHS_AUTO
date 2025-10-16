class SvgGauge {
  constructor(container, options) {
    this.container = container;
    this.minValue = options.minValue ?? 0;
    this.maxValue = options.maxValue ?? 100;
    this.unit = options.unit ?? '';
    this.title = options.title ?? 'Gauge';
    this.tickCount = options.tickCount ?? 10;
    this.dangerThreshold = options.dangerThreshold ?? this.maxValue * 0.85;
    this.warningThreshold = options.warningThreshold ?? this.maxValue * 0.7;
    this.colors = options.colors ?? {
      primary: '#448aff',
      danger: '#ff5252',
      warning: '#ffb142',
      success: '#4caf50',
      text: '#e0f7fa'
    };
    this.value = this.minValue;
    this.id = options.id ?? 'gauge';

    this._createGauge();
  }
  
  _createGauge() {
    this.container.innerHTML = `
      <div class="gauge-container" id="${this.id}">
        <div class="gauge-title">
          <svg class="gauge-icon" viewBox="0 0 24 24">${this._getIconPath()}</svg>
          <h2>${this.title}</h2>
        </div>
        <svg class="gauge-svg" viewBox="0 0 280 280" aria-label="${this.title}" role="img">
          <circle cx="140" cy="140" r="130" fill="url(#bgGradient)" filter="url(#shadow)" />
          <path class="zone-normal" />
          <path class="zone-warning" />
          <path class="zone-danger" />
          <g class="ticks"></g>
          <line class="needle" x1="140" y1="140" x2="140" y2="15" />
          <circle cx="140" cy="140" r="15" fill="url(#centerGradient)" stroke="#e0e0e0" stroke-width="1"/>
          <circle cx="140" cy="140" r="6" fill="#212121" />
          <text class="value-display" x="140" y="190" text-anchor="middle" fill="${this.colors.text}" font-size="32" font-weight="700" font-family="'Segoe UI', Tahoma, Geneva, Verdana, sans-serif" style="filter: drop-shadow(0 0 4px #448aff); user-select:none;"></text>
          <text class="unit-display" x="140" y="215" text-anchor="middle" fill="${this.colors.text}" font-size="18" font-family="'Segoe UI', Tahoma, Geneva, Verdana, sans-serif" opacity="0.7">${this.unit}</text>
          <text class="min-label" x="45" y="245" fill="#b2ebf2" font-size="14">${this.minValue}</text>
          <text class="max-label" x="235" y="245" fill="#b2ebf2" font-size="14" text-anchor="end">${this.maxValue}</text>
        </svg>
        <div class="min-max">
          <span>MIN: ${this.minValue}</span>
          <span>MAX: ${this.maxValue}</span>
        </div>
        <div class="status"><span class="led"></span><span class="status-text">ОЖИДАНИЕ ДАННЫХ</span></div>
      </div>
    `;

    const svgElem = this.container.querySelector('svg.gauge-svg');
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.innerHTML = `
      <radialGradient id="bgGradient" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#2c3b61"/>
        <stop offset="100%" stop-color="#1a243a"/>
      </radialGradient>
      <radialGradient id="centerGradient" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f5f5f5"/>
        <stop offset="100%" stop-color="#9e9e9e"/>
      </radialGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%" >
          <feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.7"/>
      </filter>
    `;
    svgElem.prepend(defs);

    this.svg = svgElem;
    this.needle = this.svg.querySelector('.needle');
    this.valueText = this.svg.querySelector('.value-display');
    this.statusText = this.container.querySelector('.status-text');
    this.statusLed = this.container.querySelector('.led');
    this.zonesNormal = this.svg.querySelector('.zone-normal');
    this.zonesWarning = this.svg.querySelector('.zone-warning');
    this.zonesDanger = this.svg.querySelector('.zone-danger');
    this.ticksGroup = this.svg.querySelector('.ticks');

    this._drawZones();
    this._drawTicks();
    this._updateNeedle(this.value);
  }

  _drawZones() {
    const startAngle = 135;
    const totalAngle = 270;
    const range = this.maxValue - this.minValue;

    const polarToCartesian = (cx, cy, radius, angleDegrees) => {
      const angleRadians = (angleDegrees - 90) * Math.PI / 180.0;
      return {
        x: cx + radius * Math.cos(angleRadians),
        y: cy + radius * Math.sin(angleRadians)
      };
    };

    const arcPath = (startAng, endAng, radius) => {
      const start = polarToCartesian(140, 140, radius, endAng);
      const end = polarToCartesian(140, 140, radius, startAng);
      const largeArcFlag = (endAng - startAng) <= 180 ? 0 : 1;
      return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
    };

    const dangerStartAng = startAngle + totalAngle * ((this.dangerThreshold - this.minValue) / range);
    const warningStartAng = startAngle + totalAngle * ((this.warningThreshold - this.minValue) / range);
    const endAng = startAngle + totalAngle;

    const radius = 120;

    this.zonesNormal.setAttribute('d', arcPath(startAngle, warningStartAng, radius));
    this.zonesWarning.setAttribute('d', arcPath(warningStartAng, dangerStartAng, radius));
    this.zonesDanger.setAttribute('d', arcPath(dangerStartAng, endAng, radius));
  }

  _drawTicks() {
    this.ticksGroup.innerHTML = '';
    const totalAngle = 270;
    const startAngle = 135;
    const minorTickLength = 8;
    const majorTickLength = 16;
    const ticksCount = this.tickCount;
    const range = this.maxValue - this.minValue;

    for (let i = 0; i <= ticksCount; i++) {
      const angle = startAngle + (totalAngle / ticksCount) * i;
      const largeTick = (i % 2 === 0);
      const tickLength = largeTick ? majorTickLength : minorTickLength;

      const outer = this._polarToCartesian(140, 140, 130, angle);
      const inner = this._polarToCartesian(140, 140, 130 - tickLength, angle);

      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute('x1', outer.x);
      line.setAttribute('y1', outer.y);
      line.setAttribute('x2', inner.x);
      line.setAttribute('y2', inner.y);
      line.setAttribute('stroke', '#a0bfff');
      line.setAttribute('stroke-width', largeTick ? '3' : '1.5');
      line.setAttribute('stroke-linecap', 'round');
      this.ticksGroup.appendChild(line);

      if (largeTick) {
        const labelPos = this._polarToCartesian(140, 140, 100, angle);
        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute('x', labelPos.x);
        text.setAttribute('y', labelPos.y + 6);
        text.setAttribute('fill', '#c2d1ff');
        text.setAttribute('font-size', '14');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-weight', '600');
        text.setAttribute('font-family', "'Segoe UI', Tahoma, Geneva, Verdana, sans-serif");
        let displayVal = this.minValue + (range / ticksCount) * i;
        if (this.maxValue > 1000) displayVal = Math.round(displayVal / 1000) + 'k';
        else displayVal = Math.round(displayVal);
        text.textContent = displayVal;
        this.ticksGroup.appendChild(text);
      }
    }
  }

  _polarToCartesian(cx, cy, radius, angleInDegrees) {
    const angleInRadians = (angleInDegrees - 90) * Math.PI / 180.0;
    return {
      x: cx + (radius * Math.cos(angleInRadians)),
      y: cy + (radius * Math.sin(angleInRadians))
    };
  }

  _updateNeedle(value) {
    if (value < this.minValue) value = this.minValue;
    if (value > this.maxValue) value = this.maxValue;
    this.value = value;
    const range = this.maxValue - this.minValue;
    const totalAngle = 270;
    const startAngle = 135;

    const angle = startAngle + (value - this.minValue) / range * totalAngle;
    this.needle.style.transform = `rotate(${angle}deg)`;

    this.valueText.textContent = Math.round(value).toLocaleString();
    if (value >= this.dangerThreshold) {
      this.valueText.style.fill = this.colors.danger;
      this.valueText.style.filter = `drop-shadow(0 0 7px ${this.colors.danger})`;
      this.statusLed.style.backgroundColor = this.colors.danger;
      this.statusLed.style.boxShadow = `0 0 7px ${this.colors.danger}`;
      this.statusText.textContent = 'ОПАСНЫЙ РЕЖИМ';
    } else if (value >= this.warningThreshold) {
      this.valueText.style.fill = this.colors.warning;
      this.valueText.style.filter = `drop-shadow(0 0 7px ${this.colors.warning})`;
      this.statusLed.style.backgroundColor = this.colors.warning;
      this.statusLed.style.boxShadow = `0 0 7px ${this.colors.warning}`;
      this.statusText.textContent = 'ВЫСОКАЯ НАГРУЗКА';
    } else {
      this.valueText.style.fill = this.colors.text;
      this.valueText.style.filter = `drop-shadow(0 0 7px ${this.colors.primary})`;
      this.statusLed.style.backgroundColor = '#4caf50';
      this.statusLed.style.boxShadow = `0 0 7px #4caf50`;
      this.statusText.textContent = 'НОРМАЛЬНЫЙ РЕЖИМ';
    }
  }

  setValue(value) {
    this._updateNeedle(value);
  }

  _getIconPath() {
    return this.iconPath ?? `<path d="M13,2.05V5.08C16.39,5.57 19,8.47 19,12C19,12.9 18.82,13.75 18.5,14.54L21.12,16.07C21.68,14.83 22,13.45 22,12C22,6.82 18.05,2.55 13,2.05M12,19A7,7 0 0,1 5,12C5,8.47 7.61,5.57 11,5.08V2.05C5.94,2.55 2,6.81 2,12A10,10 0 0,0 12,22C15.3,22 18.23,20.39 20.05,17.91L17.45,16.38C16.17,18 14.21,19 12,19Z" />`;
  }
}

const icons = {
  rpm: `<path d="M13,2.05V5.08C16.39,5.57 19,8.47 19,12C19,12.9 18.82,13.75 18.5,14.54L21.12,16.07C21.68,14.83 22,13.45 22,12C22,6.82 18.05,2.55 13,2.05M12,19A7,7 0 0,1 5,12C5,8.47 7.61,5.57 11,5.08V2.05C5.94,2.55 2,6.81 2,12A10,10 0 0,0 12,22C15.3,22 18.23,20.39 20.05,17.91L17.45,16.38C16.17,18 14.21,19 12,19Z" />`,
  temperature: `<path d="M7 11a5 5 0 1 1 6 0v6a2 2 0 1 1-6 0v-6z" />`,
  thrust: `<path d="M12 2L15 8h-6l3-6zm0 20c-4.41 0-8-1.79-8-4v-3h16v3c0 2.21-3.59 4-8 4z" />`
};

function createGaugeWithIcon(containerId, options) {
  options.id = containerId;
  options.iconPath = options.iconPath || icons.rpm;
  const container = document.createElement('div');
  document.getElementById('dashboard').appendChild(container);
  return new SvgGauge(container, options);
}



// Создаем гейджи
const X = createGaugeWithIcon('X', {
  minValue: 0, maxValue: 12000, unit: '°', tickCount: 10,
  dangerThreshold: 8000, warningThreshold: 4000,
  colors: { primary:'#448aff', danger:'#ff5252', warning:'#ffb142', success:'#4caf50', text:'#e0f7fa' },
  title: 'Обороты двигателя',
  iconPath: icons.temperature
});
const Y = createGaugeWithIcon('Y', {
  minValue: 0, maxValue: 100, unit: '°', tickCount: 10,
  dangerThreshold: 80, warningThreshold: 50,
  colors: { primary:'#00bcd4', danger:'#ff5252', warning:'#ffb142', success:'#4caf50', text:'#e0f7fa' },
  title: 'Угол Опережения',
  iconPath: icons.temperature
});
const Z = createGaugeWithIcon('Z', {
  minValue: 0, maxValue: 40000, unit: '°', tickCount: 10,
  dangerThreshold: 35000, warningThreshold: 20000,
  colors: { primary:'#ff4081', danger:'#ff5252', warning:'#ffb142', success:'#4caf50', text:'#e0f7fa' },
  title: 'Задержка',
  iconPath: icons.thrust
});
const AX = createGaugeWithIcon('AX', {
  minValue: 0, maxValue: 100, unit: '°', tickCount: 10,
  dangerThreshold: 80, warningThreshold: 50,
  colors: { primary:'#448aff', danger:'#ff5252', warning:'#ffb142', success:'#4caf50', text:'#e0f7fa' },
  title: 'Положение Дросселя',
  iconPath: icons.temperature
});
const AY = createGaugeWithIcon('AY', {
  minValue: 0, maxValue: 300, unit: '°', tickCount: 10,
  dangerThreshold: 200, warningThreshold: 100,
  colors: { primary:'#00bcd4', danger:'#ff5252', warning:'#ffb142', success:'#4caf50', text:'#e0f7fa' },
  title: 'Напряжение HV',
  iconPath: icons.temperature
});


// WebSocket соединение через Socket.IO
let socket = null;

function initWebSocket() {
    console.log('Initializing Socket.IO connection...');
    
    // Socket.IO автоматически подключается к текущему хосту
    socket = io();
    
    socket.on('connect', function() {
        console.log('Socket.IO connected successfully');
        document.getElementById('connectionStatus').className = 'connection-status connected';
    });
    
    socket.on('data_update', function(data) {
        console.log('Live data update received:', data);
        
        // Обновляем гейджи
        X.setValue(data.X);
        Y.setValue(data.Y);
        Z.setValue(data.Z);
        AX.setValue(data.AX);
        AY.setValue(data.AY);

    });
    
    socket.on('disconnect', function() {
        console.log('Socket.IO disconnected');
        document.getElementById('connectionStatus').className = 'connection-status disconnected';
        // Пытаемся переподключиться через 3 секунды
        setTimeout(initWebSocket, 3000);
    });
    
    socket.on('connect_error', function(error) {
        console.error('Socket.IO connection error:', error);
        document.getElementById('connectionStatus').className = 'connection-status error';
    });
}

// Основная функция инициализации
function initializeApp() {
    // Инициализируем WebSocket соединение
    initWebSocket();
}

window.addEventListener('load', initializeApp);