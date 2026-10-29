/**
 * SISTEMA AMORTIGUADOR DE VEHÍCULOS — SIMULACIÓN FÍSICA Y TERMODINÁMICA
 * Universidad Autónoma de Occidente (UAO)
 * Basado en el modelo matemático EDO de 2° orden y balance calorimétrico del fluido hidráulico.
 */

;(function () {
  'use strict'

  // ============================================================================
  // 1. PROPIEDADES DE LOS FLUIDOS HIDRÁULICOS (Sección 3.4 del Proyecto)
  // ============================================================================
  const FLUID_TYPES = {
    synthetic: {
      name: 'Aceite Sintético Alta Gama',
      cp: 2300, // Calor específico J/(kg·°C)
      rho: 850, // Densidad kg/m³
      fadeAlpha: 0.0065 // Baja pérdida de viscosidad con T
    },
    standard: {
      name: 'Aceite Hidráulico Estándar',
      cp: 1900, // Calor específico J/(kg·°C)
      rho: 880, // Densidad kg/m³
      fadeAlpha: 0.013 // Pérdida moderada de viscosidad con T
    },
    degraded: {
      name: 'Aceite Mineral Baja Capacidad',
      cp: 1300, // Calor específico J/(kg·°C) - Se calienta rápido
      rho: 910, // Densidad kg/m³
      fadeAlpha: 0.022 // Alta sensibilidad al Fading Térmico
    }
  }

  const CYLINDER_VOLUME = 0.00045 // 450 cm³ (0.00045 m³) de aceite en el amortiguador
  const C_CYLINDER_STEEL = 550.0 // Capacidad térmica del cilindro metálico (1.15 kg acero * 480 J/kg°C)
  const T_AMBIENT = 25.0 // Temperatura ambiente (°C)
  const T_MAX_SAFE = 90.0 // Umbral de degradación térmica / Fading (°C)
  const CONV_BASE_HA = 14.0 // Coeficiente base h·A de convección natural al aire (W/°C)
  const CONV_WIND_FACTOR = 3.8 // Factor de convección forzada por viento al avanzar el vehículo

  // ============================================================================
  // 2. ESTADO GLOBAL DE LA SIMULACIÓN
  // ============================================================================
  const state = {
    // Parámetros mecánicos configurables
    m: 400, // Masa suspendida (carrocería) [kg]
    k: 35000, // Constante elástica del resorte [N/m]
    bNominal: 1650, // Coeficiente de amortiguamiento nominal a 25°C [N·s/m]
    vKmh: 25, // Velocidad horizontal del vehículo [km/h] (inicia suave a 25 km/h)
    bumpHeightCm: 10, // Altura de las irregularidades [cm]
    timeScale: 1.0, // Factor de cámara lenta (0.05x a 1.0x)
    paused: false,

    // Configuración de terreno y fluido
    terrainType: 'periodic', // 'periodic' | 'pothole' | 'washboard' | 'flat'
    fluidKey: 'standard',
    thermalScale: 15, // Escala temporal térmica equilibrada (multiplica calentamiento Y convección)
    fadingEnabled: true,

    // Variables dinámicas de estado (EDO 2° orden)
    t: 0, // Tiempo físico simulado [s]
    s: 0, // Distancia horizontal recorrida por la rueda delantera [m]
    x: 0, // Desplazamiento vertical de la carrocería respecto al equilibrio [m]
    vx: 0, // Velocidad vertical de la carrocería dx/dt [m/s]
    ax: 0, // Aceleración vertical d²x/dt² [m/s²]

    // Variables de la base (rueda sobre el terreno)
    y: 0, // Altura del terreno bajo la rueda principal [m]
    vy: 0, // Velocidad vertical de la rueda dy/dt [m/s]
    yRear: 0, // Altura del terreno bajo la rueda trasera [m]

    // Fuerzas instantáneas
    Fk: 0, // Fuerza de restitución del resorte: -k*(x - y) [N]
    Fb: 0, // Fuerza viscosa del amortiguador: -b_ef*(vx - vy) [N]

    // Variables termodinámicas del aceite
    tempOil: T_AMBIENT, // Temperatura actual del aceite [°C]
    qTotalJ: 0, // Calor total generado acumulado Q [Joules]
    powerViscW: 0, // Potencia disipada instantánea b*v_rel² [W]
    powerConvW: 0, // Potencia evacuada por convección [W]
    viscFactor: 1.0, // Fracción de viscosidad remanente (1.0 = 100%)
    bEffective: 1650, // Coeficiente de amortiguamiento real b(T) [N·s/m]

    // Seguimiento de envolvente exponencial teórica (para la gráfica x(t))
    envAmp: 0,
    envT0: 0,
    inBumpPrev: false,

    // Lista de baches generados manualmente (posiciones en metros)
    manualBumps: []
  }

  // Historial circular para las 3 gráficas en tiempo real
  const CHART_HISTORY_SECONDS = 8.0
  const history = [] // Elementos: { t, xCm, yCm, envCm, Fk, Fb, temp, qKJ }
  let chartSampleAccum = 0

  // Partículas de fluido para la animación del corte transversal del amortiguador
  const oilParticles = []
  const NUM_PARTICLES = 65
  for (let i = 0; i < NUM_PARTICLES; i++) {
    oilParticles.push({
      rx: (Math.random() - 0.5) * 0.82, // Posición horizontal relativa (-0.5 a 0.5)
      ry: Math.random(), // Posición vertical relativa en la cámara (0 a 1)
      size: 2.0 + Math.random() * 2.2,
      phase: Math.random() * Math.PI * 2,
      jet: i < 18 // Partículas que cruzan por las microválvulas
    })
  }

  // ============================================================================
  // 3. REFERENCIAS AL DOM Y CANVAS
  // ============================================================================
  const dom = {
    regimeBadge: document.getElementById('regime-badge'),
    regimeBadgeText: document.getElementById('regime-badge-text'),
    fadingBadge: document.getElementById('fading-badge'),

    presetBtns: {
      none: document.getElementById('preset-none'),
      under: document.getElementById('preset-under'),
      critical: document.getElementById('preset-crit'),
      over: document.getElementById('preset-over')
    },

    btnBump: document.getElementById('btn-bump'),
    btnPause: document.getElementById('btn-pause'),
    btnReset: document.getElementById('btn-reset'),
    btnCoolOil: document.getElementById('btn-cool-oil'),
    btnHeatOil: document.getElementById('btn-heat-oil'),

    sliderTimeScale: document.getElementById('slider-timescale'),
    valTimeScale: document.getElementById('val-timescale'),
    pillBtns: document.querySelectorAll('.pill-btn'),

    sliderB: document.getElementById('slider-b'),
    valB: document.getElementById('val-b'),
    labelBcrit: document.getElementById('label-bcrit'),

    sliderK: document.getElementById('slider-k'),
    valK: document.getElementById('val-k'),

    sliderM: document.getElementById('slider-m'),
    valM: document.getElementById('val-m'),

    sliderV: document.getElementById('slider-v'),
    valV: document.getElementById('val-v'),

    sliderBumpH: document.getElementById('slider-bump-h'),
    valBumpH: document.getElementById('val-bump-h'),

    selectTerrain: document.getElementById('select-terrain'),
    selectFluid: document.getElementById('select-fluid'),
    selectThermalScale: document.getElementById('select-thermal-scale'),
    chkFading: document.getElementById('chk-fading'),

    // Panel matemático y termodinámico
    liveEdoText: document.getElementById('live-edo-text'),
    mathB2: document.getElementById('math-b2'),
    mathComparison: document.getElementById('math-comparison'),
    math4mk: document.getElementById('math-4mk'),
    mathZeta: document.getElementById('math-zeta'),
    mathForceRel: document.getElementById('math-force-rel'),
    mathW0: document.getElementById('math-w0'),
    mathBef: document.getElementById('math-bef'),

    valTemp: document.getElementById('val-temp'),
    valDeltaT: document.getElementById('val-deltat'),
    thermometerFill: document.getElementById('thermometer-fill'),
    valQ: document.getElementById('val-q'),
    valPower: document.getElementById('val-power'),
    valCp: document.getElementById('val-cp'),
    valRho: document.getElementById('val-rho'),
    valVisc: document.getElementById('val-visc'),
    valConv: document.getElementById('val-conv')
  }

  const canvases = {
    car: document.getElementById('canvas-car'),
    damper: document.getElementById('canvas-damper'),
    chartPos: document.getElementById('chart-pos'),
    chartForces: document.getElementById('chart-forces'),
    chartThermo: document.getElementById('chart-thermo')
  }

  const ctxs = {
    car: canvases.car.getContext('2d'),
    damper: canvases.damper.getContext('2d'),
    chartPos: canvases.chartPos.getContext('2d'),
    chartForces: canvases.chartForces.getContext('2d'),
    chartThermo: canvases.chartThermo.getContext('2d')
  }

  // Ajuste de resolución DPI en todos los canvas
  function resizeAllCanvases() {
    const dpr = window.devicePixelRatio || 1
    Object.keys(canvases).forEach((key) => {
      const c = canvases[key]
      const rect = c.parentElement.getBoundingClientRect()
      const w = Math.max(100, Math.floor(rect.width))
      const h = Math.max(80, Math.floor(rect.height))
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr
        c.height = h * dpr
      }
      ctxs[key].setTransform(dpr, 0, 0, dpr, 0, 0)
      c._logicalW = w
      c._logicalH = h
    })
  }

  window.addEventListener('resize', resizeAllCanvases)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => resizeAllCanvases())
    Object.keys(canvases).forEach((key) => {
      if (canvases[key] && canvases[key].parentElement) {
        ro.observe(canvases[key].parentElement)
      }
    })
  }

  // ============================================================================
  // 4. GEOMETRÍA DEL TERRENO y(s) Y SU DERIVADA dy/ds
  // ============================================================================
  /**
   * Evalúa la altura del terreno y(s) [m] y la pendiente dy/ds en la posición horizontal s [m].
   * Usa perfiles C¹ continuos (coseno elevado) para evitar discontinuidades irreales.
   */
  function evaluateTerrainAt(s) {
    if (s < 3.5) {
      return { y: 0, dyds: 0 }
    }

    const H = state.bumpHeightCm / 100.0 // Convertir cm a metros
    let y = 0
    let dyds = 0

    // 1. Contribución del terreno seleccionado
    if (state.terrainType === 'periodic') {
      // Resalto progresivo cada 18 metros (inicia en s = 5.5 m para arrancar estable)
      const period = 18.0
      const bumpLen = 2.4
      const offset = (s - 5.5) % period
      if (offset >= 0 && offset <= bumpLen) {
        const phase = (2 * Math.PI * offset) / bumpLen
        y += 0.5 * H * (1 - Math.cos(phase))
        dyds += 0.5 * H * ((2 * Math.PI) / bumpLen) * Math.sin(phase)
      }
    } else if (state.terrainType === 'pothole') {
      // Bache doble (hueco seguido de resalto) cada 19 metros
      const period = 19.0
      const bumpLen = 2.7
      const offset = (s - 5.5) % period
      if (offset >= 0 && offset <= bumpLen) {
        const phase = (2 * Math.PI * offset) / bumpLen
        // Sinusoide modulada por ventana de Hann para que sea C¹ en los bordes
        const windowHann = 0.5 * (1 - Math.cos(phase))
        const dWindow = 0.5 * ((2 * Math.PI) / bumpLen) * Math.sin(phase)
        const wave = -Math.sin(phase)
        const dWave = -((2 * Math.PI) / bumpLen) * Math.cos(phase)
        y += 0.85 * H * (windowHann * wave)
        dyds += 0.85 * H * (dWindow * wave + windowHann * dWave)
      }
    } else if (state.terrainType === 'washboard') {
      // Terreno rizado continuo (ideal para ver el calentamiento progresivo del aceite y el fading)
      const wavelength = 2.6
      const amp = 0.32 * H
      const kWave = (2 * Math.PI) / wavelength
      // Entrada progresiva suave
      const ramp = Math.min(1.0, Math.max(0.0, (s - 4.0) / 2.0))
      y += ramp * amp * Math.sin(kWave * (s - 4.0))
      dyds += ramp * amp * kWave * Math.cos(kWave * (s - 4.0))
    }

    // 2. Contribución de baches manuales lanzados con el botón "¡Generar Bache Ahora!"
    const manualLen = 2.1
    for (let i = 0; i < state.manualBumps.length; i++) {
      const bStart = state.manualBumps[i]
      const u = s - bStart
      if (u >= 0 && u <= manualLen) {
        const phase = (2 * Math.PI * u) / manualLen
        y += 0.5 * H * (1 - Math.cos(phase))
        dyds += 0.5 * H * ((2 * Math.PI) / manualLen) * Math.sin(phase)
      }
    }

    return { y, dyds }
  }

  // Genera un bache inmediatamente delante del vehículo
  function triggerManualBump() {
    const targetS = Math.max(3.6, state.s + 0.65)
    // Evitar encimar dos baches manuales en el mismo tramo
    const tooClose = state.manualBumps.some((b) => Math.abs(b - targetS) < 1.8)
    if (!tooClose) {
      state.manualBumps.push(targetS)
      // Limpiar baches muy antiguos
      if (state.manualBumps.length > 12) {
        state.manualBumps.shift()
      }
    }
  }

  // ============================================================================
  // 5. MOTOR FÍSICO: INTEGRACIÓN RUNGE-KUTTA 4 (RK4) Y BALANCE TÉRMICO
  // ============================================================================
  function computeEffectiveDamping() {
    const fluid = FLUID_TYPES[state.fluidKey]
    if (!state.fadingEnabled || state.tempOil <= 35.0) {
      state.viscFactor = 1.0
    } else {
      // Pérdida exponencial de viscosidad con la temperatura + caída pronunciada en Fading (>90°C)
      const excessT = state.tempOil - 35.0
      let factor = Math.exp(-fluid.fadeAlpha * excessT)
      if (state.tempOil > T_MAX_SAFE) {
        const overFade = state.tempOil - T_MAX_SAFE
        factor *= Math.exp(-0.018 * overFade)
      }
      state.viscFactor = Math.max(0.15, Math.min(1.0, factor))
    }
    state.bEffective = state.bNominal * state.viscFactor
  }

  /**
   * Avanza la simulación un paso de tiempo físico dt [s] usando RK4
   */
  function stepPhysicsRK4(dt) {
    // Rampa de arranque suave durante el primer segundo para que el carro no inicie de golpe
    const startupRamp = Math.min(1.0, (state.t + 0.15) / 1.0)
    const vCar = (state.vKmh / 3.6) * startupRamp // km/h -> m/s
    computeEffectiveDamping()

    const m = state.m
    const k = state.k
    const b = state.bEffective
    // Factor de filtrado elástico del neumático sobre la velocidad vertical de la irregularidad
    const tireFilter = 0.65

    // Función derivada para RK4: retorna [dx/dt, dvx/dt] en (t_local, x_val, vx_val, s_val)
    function deriv(xVal, vxVal, sVal) {
      const terr = evaluateTerrainAt(sVal)
      const yVal = terr.y
      const vyVal = terr.dyds * vCar * tireFilter

      const z = xVal - yVal
      const vRel = vxVal - vyVal

      const fk = -k * z
      const fb = -b * vRel
      const accel = (fk + fb) / m
      return [vxVal, accel]
    }

    const s0 = state.s
    const x0 = state.x
    const vx0 = state.vx

    // Paso 1 de RK4
    const [dx1, dv1] = deriv(x0, vx0, s0)

    // Paso 2 de RK4
    const sHalf = s0 + 0.5 * vCar * dt
    const [dx2, dv2] = deriv(x0 + 0.5 * dt * dx1, vx0 + 0.5 * dt * dv1, sHalf)

    // Paso 3 de RK4
    const [dx3, dv3] = deriv(x0 + 0.5 * dt * dx2, vx0 + 0.5 * dt * dv2, sHalf)

    // Paso 4 de RK4
    const sEnd = s0 + vCar * dt
    const [dx4, dv4] = deriv(x0 + dt * dx3, vx0 + dt * dv3, sEnd)

    // Actualizar estado cinemático
    state.x = x0 + (dt / 6.0) * (dx1 + 2 * dx2 + 2 * dx3 + dx4)
    state.vx = vx0 + (dt / 6.0) * (dv1 + 2 * dv2 + 2 * dv3 + dv4)
    state.s = sEnd
    state.t += dt

    // Evaluar terreno actual bajo la rueda principal y trasera (distancia entre ejes = 2.7 m)
    const terrFront = evaluateTerrainAt(state.s)
    state.y = terrFront.y
    state.vy = terrFront.dyds * vCar * tireFilter

    const terrRear = evaluateTerrainAt(Math.max(0, state.s - 2.7))
    state.yRear = terrRear.y

    // Tope elástico físico de seguridad (evita que por resonancia extrema con b=0 se salga del chasis)
    const maxStroke = 0.24 // ±24 cm de carrera física máxima
    const zNow = state.x - state.y
    if (Math.abs(zNow) > maxStroke) {
      const sign = Math.sign(zNow)
      state.x = state.y + sign * maxStroke
      state.vx *= -0.45
    }

    // Calcular fuerzas actuales e inercia
    const z = state.x - state.y
    const vRel = state.vx - state.vy
    state.Fk = -k * z
    state.Fb = -b * vRel
    state.ax = (state.Fk + state.Fb) / m

    // ------------------------------------------------------------------------
    // SEGUIMIENTO DE ENVOLVENTE EXPONENCIAL TEÓRICA (±A · e^(-(b/2m)(t - t0)))
    // ------------------------------------------------------------------------
    const onBump = Math.abs(state.y) > 0.0015 || Math.abs(state.vy) > 0.01
    if (onBump) {
      // Mientras cruza la irregularidad, actualizamos la amplitud pico de entrada
      const totalMechAmp = Math.sqrt(state.x * state.x + (state.vx / Math.sqrt(k / m)) ** 2)
      state.envAmp = Math.max(Math.abs(state.x), totalMechAmp)
      state.envT0 = state.t
    } else if (state.inBumpPrev && !onBump) {
      // Justo al salir del bache hacia terreno plano, fijamos A0 y t0
      const w0 = Math.sqrt(k / m)
      state.envAmp = Math.sqrt(state.x * state.x + (state.vx / w0) ** 2)
      state.envT0 = state.t
    }
    state.inBumpPrev = onBump

    // ------------------------------------------------------------------------
    // TERMODINÁMICA Y CALORIMETRÍA DEL FLUIDO HIDRÁULICO (Sección 3.4)
    // ------------------------------------------------------------------------
    const fluid = FLUID_TYPES[state.fluidKey]
    const mOil = fluid.rho * CYLINDER_VOLUME // m_aceite = ρ · V [kg]
    // Capacidad térmica total: fluido hidráulico + cuerpo metálico intercambiador (J/°C)
    const totalHeatCapacity = mOil * fluid.cp + C_CYLINDER_STEEL

    // Potencia mecánica disipada por rozamiento viscoso: dQ_gen/dt = b_ef * v_rel² [W]
    state.powerViscW = b * (vRel * vRel)
    const dQGen = state.powerViscW * dt
    state.qTotalJ += dQGen

    // Coeficiente de convección forzada al aire exterior dependiente de la velocidad del carro
    const effectiveHA = CONV_BASE_HA + CONV_WIND_FACTOR * Math.sqrt(vCar)
    state.powerConvW = Math.max(0, effectiveHA * (state.tempOil - T_AMBIENT))

    // Balance térmico diferencial simétrico: la escala temporal multiplica tanto generación como disipación
    const netHeatRate = state.thermalScale * (state.powerViscW - state.powerConvW)
    const dTemp = (netHeatRate * dt) / totalHeatCapacity
    state.tempOil = Math.max(T_AMBIENT, Math.min(145.0, state.tempOil + dTemp))

    // Animar partículas internas del amortiguador proporcionalmente a v_rel
    updateDamperParticles(dt, vRel)
  }

  function updateDamperParticles(dt, vRel) {
    // Si bNominal == 0, no hay fluido viscoso activo
    if (state.bNominal <= 0) return

    for (let i = 0; i < oilParticles.length; i++) {
      const p = oilParticles[i]
      // Flujo opuesto al movimiento del pistón a través de las microválvulas
      const flowSpeed = -vRel * (p.jet ? 2.6 : 0.85)
      p.ry += flowSpeed * dt + Math.sin(state.t * 5 + p.phase) * 0.08 * dt
      if (p.ry > 1.0) p.ry -= 1.0
      if (p.ry < 0.0) p.ry += 1.0
    }
  }

  // ============================================================================
  // 6. PRESETS DE RÉGIMEN Y ACTUALIZACIÓN DE INTERFAZ
  // ============================================================================
  function getCriticalDamping() {
    return 2 * Math.sqrt(state.m * state.k)
  }

  function classifyCurrentRegime() {
    const b = state.bEffective
    const bCrit = getCriticalDamping()
    const zeta = b / bCrit

    if (state.bNominal === 0 || zeta < 0.005) {
      return { id: 'none', zeta: 0, bCrit }
    } else if (Math.abs(zeta - 1.0) <= 0.03) {
      return { id: 'critical', zeta, bCrit }
    } else if (zeta < 1.0) {
      return { id: 'under', zeta, bCrit }
    } else {
      return { id: 'over', zeta, bCrit }
    }
  }

  function applyRegimePreset(regimeId) {
    const bCrit = getCriticalDamping()
    if (regimeId === 'none') {
      state.bNominal = 0
    } else if (regimeId === 'under') {
      // Subamortiguado automotriz típico (ζ ≈ 0.22)
      state.bNominal = Math.round((0.22 * bCrit) / 10) * 10
    } else if (regimeId === 'critical') {
      // Críticamente amortiguado exacto (b = √(4mk), ζ = 1.00)
      state.bNominal = Math.round(bCrit)
    } else if (regimeId === 'over') {
      // Sobreamortiguado (ζ ≈ 1.85)
      state.bNominal = Math.min(15000, Math.round((1.85 * bCrit) / 25) * 25)
    }

    dom.sliderB.value = state.bNominal
    computeEffectiveDamping()
    syncControlsAndHUD()

    // Lanzar un bache inmediato para visualizar la respuesta del régimen elegido
    state.x = 0
    state.vx = 0
    triggerManualBump()
  }

  function formatSci(num) {
    if (num === 0) return '0'
    if (num < 10000) return num.toFixed(0)
    const exp = Math.floor(Math.log10(Math.abs(num)))
    const mant = (num / Math.pow(10, exp)).toFixed(2)
    const supDigits = ['⁰', '¹', '²', '³', '⁴', '⁵', '⁶', '⁷', '⁸', '⁹']
    const expStr = String(exp)
      .split('')
      .map((ch) => (ch === '-' ? '⁻' : supDigits[Number(ch)]))
      .join('')
    return `${mant} × 10${expStr}`
  }

  function syncControlsAndHUD() {
    computeEffectiveDamping()
    const bCrit = getCriticalDamping()
    const reg = classifyCurrentRegime()

    // Actualizar textos de sliders
    dom.valB.textContent = `${Math.round(state.bNominal)} N·s/m`
    dom.labelBcrit.textContent = `b_crítico = ${Math.round(bCrit)} N·s/m`
    dom.valK.textContent = `${state.k} N/m`
    dom.valM.textContent = `${state.m} kg`
    const vMs = (state.vKmh / 3.6).toFixed(1)
    dom.valV.textContent = `${state.vKmh} km/h (${vMs} m/s)`
    dom.valBumpH.textContent = `${state.bumpHeightCm.toFixed(1)} cm`
    dom.valTimeScale.textContent = `${state.timeScale.toFixed(2)}x`

    // Actualizar botones de preset activos
    Object.keys(dom.presetBtns).forEach((k) => {
      dom.presetBtns[k].classList.toggle('active', k === reg.id)
    })

    // Actualizar Badge superior de régimen
    dom.regimeBadge.className = 'badge'
    if (reg.id === 'none') {
      dom.regimeBadge.classList.add('badge-none')
      dom.regimeBadgeText.textContent = 'SIN AMORTIGUADOR (b = 0 · Oscilación Armónica Simple)'
    } else if (reg.id === 'under') {
      dom.regimeBadge.classList.add('badge-sub')
      dom.regimeBadgeText.textContent = 'RÉGIMEN SUBAMORTIGUADO (b² < 4mk · Oscila y decae)'
    } else if (reg.id === 'critical') {
      dom.regimeBadge.classList.add('badge-crit')
      dom.regimeBadgeText.textContent = 'RÉGIMEN CRÍTICAMENTE AMORTIGUADO (b² = 4mk · Óptimo)'
    } else {
      dom.regimeBadge.classList.add('badge-over')
      dom.regimeBadgeText.textContent = 'RÉGIMEN SOBREAMORTIGUADO (b² > 4mk · Retorno lento)'
    }

    // Alerta de Fading Térmico
    const isFading = state.tempOil >= T_MAX_SAFE && state.bNominal > 0
    dom.fadingBadge.classList.toggle('hidden', !isFading)

    // Panel Matemático (Sección 3.2 y 3.3 del PDF)
    const bUsed = Math.round(state.bEffective)
    dom.liveEdoText.textContent = `${state.m}·x'' + ${bUsed}·x' + ${state.k}·x = 0`

    const b2 = state.bEffective * state.bEffective
    const fourMK = 4 * state.m * state.k
    dom.mathB2.textContent = formatSci(b2)
    dom.math4mk.textContent = formatSci(fourMK)

    if (reg.id === 'critical') {
      dom.mathComparison.textContent = '='
      dom.mathForceRel.textContent = 'F_R = F_A (Sin rebote)'
      dom.mathForceRel.className = 'mono highlight-green'
    } else if (reg.id === 'none') {
      dom.mathComparison.textContent = '<'
      dom.mathForceRel.textContent = 'F_A = 0 (Rebote perpetuo)'
      dom.mathForceRel.className = 'mono highlight-cyan'
    } else if (reg.id === 'under') {
      dom.mathComparison.textContent = '<'
      dom.mathForceRel.textContent = 'F_R > F_A (Oscila)'
      dom.mathForceRel.className = 'mono highlight-cyan'
    } else {
      dom.mathComparison.textContent = '>'
      dom.mathForceRel.textContent = 'F_A > F_R (Sobrerígido)'
      dom.mathForceRel.className = 'mono highlight-orange'
    }

    dom.mathZeta.textContent = reg.zeta.toFixed(3)
    const w0 = Math.sqrt(state.k / state.m)
    dom.mathW0.textContent = `${w0.toFixed(2)} rad/s`
    const pctVisc = Math.round(state.viscFactor * 100)
    dom.mathBef.textContent = `${bUsed} N·s/m (${pctVisc}%)`

    // Panel Termodinámico (Sección 3.4 del PDF)
    const fluid = FLUID_TYPES[state.fluidKey]
    const mOil = fluid.rho * CYLINDER_VOLUME
    const deltaT = state.tempOil - T_AMBIENT

    dom.valTemp.textContent = `${state.tempOil.toFixed(1)} °C`
    dom.valTemp.style.color = getOilColorCSS(state.tempOil)
    dom.valDeltaT.textContent = `ΔT = +${deltaT.toFixed(1)} °C`

    const fillPct = Math.max(4, Math.min(100, ((state.tempOil - 25) / (130 - 25)) * 100))
    dom.thermometerFill.style.width = `${fillPct}%`

    const qKJ = state.qTotalJ / 1000
    dom.valQ.textContent = `${qKJ.toFixed(2)} kJ (${Math.round(state.qTotalJ)} J)`
    dom.valPower.textContent = `${Math.round(state.powerViscW)} W`
    dom.valCp.textContent = `${fluid.cp} J/(kg·°C)`
    dom.valRho.textContent = `${fluid.rho} kg/m³ (${mOil.toFixed(2)} kg)`

    if (state.bNominal === 0) {
      dom.valVisc.textContent = 'Sin fluido (b = 0)'
      dom.valVisc.style.color = '#94a3b8'
    } else if (state.tempOil >= T_MAX_SAFE) {
      dom.valVisc.textContent = `${pctVisc}% (¡FADING TÉRMICO!)`
      dom.valVisc.style.color = '#ef4444'
    } else if (pctVisc < 85) {
      dom.valVisc.textContent = `${pctVisc}% (Adelgazándose)`
      dom.valVisc.style.color = '#f59e0b'
    } else {
      dom.valVisc.textContent = `${pctVisc}% (Viscosidad Óptima)`
      dom.valVisc.style.color = '#10b981'
    }

    dom.valConv.textContent = `${state.powerConvW.toFixed(1)} W`
  }

  // Función auxiliar para interpolar el color del aceite según su temperatura
  function getOilRGB(temp) {
    // 25°C: Ámbar dorado / azul frío (56, 189, 248 mezclado con ámbar 234, 179, 8)
    // 65°C: Naranja intenso (249, 115, 22)
    // 95°C+: Rojo incandescente (239, 68, 68)
    const t = Math.max(25, Math.min(120, temp))
    if (t <= 60) {
      const u = (t - 25) / 35
      const r = Math.round(56 + u * (245 - 56))
      const g = Math.round(189 + u * (158 - 189))
      const b = Math.round(248 + u * (11 - 248))
      return { r, g, b }
    } else {
      const u = (t - 60) / 45
      const r = Math.round(245 + Math.min(1, u) * (239 - 245))
      const g = Math.round(158 + Math.min(1, u) * (45 - 158))
      const b = Math.round(11 + Math.min(1, u) * (45 - 11))
      return { r, g, b }
    }
  }

  function getOilColorCSS(temp, alpha = 1) {
    const { r, g, b } = getOilRGB(temp)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  // ============================================================================
  // 7. DIBUJO EN CANVAS 1: SIMULACIÓN 2D DEL VEHÍCULO Y TERRENO
  // ============================================================================
  function drawSpring2D(ctx, x1, y1, x2, y2, coils, radius, color, lineWidth) {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy)
    if (len < 4) return

    const ux = dx / len
    const uy = dy / len
    const nx = -uy
    const ny = ux

    const pad = Math.min(8, len * 0.1)
    const activeLen = len - 2 * pad

    ctx.save()
    ctx.beginPath()
    ctx.strokeStyle = color
    ctx.lineWidth = lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    ctx.moveTo(x1, y1)
    const startX = x1 + ux * pad
    const startY = y1 + uy * pad
    ctx.lineTo(startX, startY)

    const steps = coils * 2
    for (let i = 1; i <= steps; i++) {
      const frac = (i - 0.5) / steps
      const side = i % 2 === 1 ? 1 : -1
      const px = startX + ux * (activeLen * frac) + nx * radius * side
      const py = startY + uy * (activeLen * frac) + ny * radius * side
      ctx.lineTo(px, py)
    }

    const endX = x2 - ux * pad
    const endY = y2 - uy * pad
    ctx.lineTo(endX, endY)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    ctx.restore()
  }

  function drawForceArrow(ctx, x, yStart, forceN, maxScaleN, maxPx, color, label) {
    const magPx = Math.max(-maxPx, Math.min(maxPx, (forceN / maxScaleN) * maxPx))
    if (Math.abs(magPx) < 3) return

    const yEnd = yStart - magPx // Hacia arriba es fuerza positiva (+y)
    const dir = Math.sign(yEnd - yStart)

    ctx.save()
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 3

    ctx.beginPath()
    ctx.moveTo(x, yStart)
    ctx.lineTo(x, yEnd)
    ctx.stroke()

    // Punta de flecha
    ctx.beginPath()
    ctx.moveTo(x, yEnd)
    ctx.lineTo(x - 5, yEnd - dir * 8)
    ctx.lineTo(x + 5, yEnd - dir * 8)
    ctx.closePath()
    ctx.fill()

    // Etiqueta
    ctx.font = 'bold 10px Consolas, monospace'
    ctx.textAlign = 'left'
    ctx.fillText(`${label}: ${Math.round(forceN)} N`, x + 8, yEnd + 3)
    ctx.restore()
  }

  function renderCarCanvas() {
    const c = canvases.car
    const ctx = ctxs.car
    const W = c._logicalW || 600
    const H = c._logicalH || 280

    ctx.clearRect(0, 0, W, H)

    // Escala: 1 metro = 220 píxeles para desplazamiento vertical (hace las oscilaciones muy claras)
    const pxPerMeterY = 230
    // Escala horizontal para dibujar el perfil de la carretera: 1 metro = 46 píxeles (movimiento visual más suave)
    const pxPerMeterX = 46

    const roadBaseY = H * 0.77
    const frontWheelX = W * 0.56
    const wheelbasePx = 2.7 * pxPerMeterX // 2.7 m entre ejes
    const rearWheelX = frontWheelX - wheelbasePx
    const wheelRadius = 26

    // 1. Fondo cuadriculado técnico sutil
    ctx.save()
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.28)'
    ctx.lineWidth = 1
    const gridStep = 30
    const scrollOffsetPx = (state.s * pxPerMeterX) % gridStep
    for (let gx = -scrollOffsetPx; gx < W; gx += gridStep) {
      ctx.beginPath()
      ctx.moveTo(gx, 0)
      ctx.lineTo(gx, roadBaseY)
      ctx.stroke()
    }
    for (let gy = 25; gy < roadBaseY; gy += gridStep) {
      ctx.beginPath()
      ctx.moveTo(0, gy)
      ctx.lineTo(W, gy)
      ctx.stroke()
    }
    ctx.restore()

    // 2. Dibujar perfil continuo de la carretera y(s)
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let px = 0; px <= W; px += 4) {
      const sAtPx = state.s + (px - frontWheelX) / pxPerMeterX
      const terr = evaluateTerrainAt(sAtPx)
      const py = roadBaseY - terr.y * pxPerMeterY
      ctx.lineTo(px, py)
    }
    ctx.lineTo(W, H)
    ctx.closePath()

    const roadGrad = ctx.createLinearGradient(0, roadBaseY - 15, 0, H)
    roadGrad.addColorStop(0, '#1e293b')
    roadGrad.addColorStop(0.3, '#0f172a')
    roadGrad.addColorStop(1, '#090d16')
    ctx.fillStyle = roadGrad
    ctx.fill()

    // Línea superficial del asfalto
    ctx.beginPath()
    for (let px = 0; px <= W; px += 3) {
      const sAtPx = state.s + (px - frontWheelX) / pxPerMeterX
      const terr = evaluateTerrainAt(sAtPx)
      const py = roadBaseY - terr.y * pxPerMeterY
      if (px === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = '#64748b'
    ctx.lineWidth = 3
    ctx.stroke()

    // Marcas viales de metraje en el suelo para apreciar la velocidad del carro
    ctx.fillStyle = '#475569'
    ctx.font = '10px Consolas, monospace'
    const firstMeter = Math.floor(state.s - frontWheelX / pxPerMeterX)
    const lastMeter = Math.ceil(state.s + (W - frontWheelX) / pxPerMeterX)
    for (let mMark = firstMeter; mMark <= lastMeter; mMark++) {
      if (mMark % 2 === 0 && mMark >= 0) {
        const px = frontWheelX + (mMark - state.s) * pxPerMeterX
        const terr = evaluateTerrainAt(mMark)
        const py = roadBaseY - terr.y * pxPerMeterY
        ctx.fillRect(px - 8, py + 6, 16, 3)
        if (mMark % 4 === 0) {
          ctx.fillText(`${mMark}m`, px - 10, py + 20)
        }
      }
    }
    ctx.restore()

    // 3. Posiciones exactas de las ruedas (Masa No Suspendida) y carrocería (Masa Suspendida)
    const frontWheelY = roadBaseY - state.y * pxPerMeterY - wheelRadius
    const rearWheelY = roadBaseY - state.yRear * pxPerMeterY - wheelRadius

    // Altura de equilibrio del chasis sobre las ruedas
    const eqSuspensionLen = 68
    const eqChassisY = roadBaseY - wheelRadius - eqSuspensionLen

    // La carrocería se desplaza verticalmente según x(t) resuelto por la EDO
    const frontChassisY = eqChassisY - state.x * pxPerMeterY
    // La parte trasera acompaña suavemente
    const rearChassisY = eqChassisY - (state.x * 0.85 + state.yRear * 0.15) * pxPerMeterY

    // Línea punteada de posición de equilibrio (x = 0)
    ctx.save()
    ctx.setLineDash([6, 5])
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.55)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(rearWheelX - 60, eqChassisY)
    ctx.lineTo(frontWheelX + 115, eqChassisY)
    ctx.stroke()
    ctx.fillStyle = '#10b981'
    ctx.font = '10px Consolas, monospace'
    ctx.fillText('Equilibrio x = 0', rearWheelX - 55, eqChassisY - 6)
    ctx.restore()

    // 4. Dibujar Carrocería (Masa Suspendida m) con inclinación suave entre ejes
    const chassisCenterX = (frontWheelX + rearWheelX) / 2
    const chassisCenterY = (frontChassisY + rearChassisY) / 2
    const pitchAngle =
      Math.atan2(frontChassisY - rearChassisY, frontWheelX - rearWheelX) * 0.35

    ctx.save()
    ctx.translate(chassisCenterX, chassisCenterY)
    ctx.rotate(pitchAngle)

    // Sombra de carrocería y silueta automotriz moderna
    const carLen = wheelbasePx + 110
    const carHalfL = carLen / 2

    ctx.beginPath()
    // Parte inferior del chasis
    ctx.moveTo(-carHalfL, 14)
    ctx.lineTo(carHalfL, 14)
    // Frente aerodinámico
    ctx.quadraticCurveTo(carHalfL + 16, 6, carHalfL + 10, -14)
    ctx.lineTo(carHalfL - 28, -22)
    // Parabrisas y techo
    ctx.lineTo(carHalfL - 78, -54)
    ctx.lineTo(-carHalfL + 60, -54)
    // Luneta trasera y baúl
    ctx.lineTo(-carHalfL + 18, -24)
    ctx.lineTo(-carHalfL - 6, -18)
    ctx.quadraticCurveTo(-carHalfL - 12, 0, -carHalfL, 14)
    ctx.closePath()

    const bodyGrad = ctx.createLinearGradient(0, -56, 0, 18)
    bodyGrad.addColorStop(0, '#1e40af')
    bodyGrad.addColorStop(0.55, '#1d4ed8')
    bodyGrad.addColorStop(1, '#0f172a')
    ctx.fillStyle = bodyGrad
    ctx.fill()
    ctx.lineWidth = 2
    ctx.strokeStyle = '#60a5fa'
    ctx.stroke()

    // Ventanillas
    ctx.beginPath()
    ctx.moveTo(carHalfL - 34, -22)
    ctx.lineTo(carHalfL - 78, -48)
    ctx.lineTo(-carHalfL + 65, -48)
    ctx.lineTo(-carHalfL + 30, -22)
    ctx.closePath()
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.5)'
    ctx.lineWidth = 1.2
    ctx.stroke()

    // Faro delantero con haz de luz
    ctx.fillStyle = '#fef08a'
    ctx.beginPath()
    ctx.ellipse(carHalfL + 8, -9, 4, 6, 0.2, 0, Math.PI * 2)
    ctx.fill()

    // Etiqueta de Masa Suspendida (m)
    ctx.fillStyle = '#e2e8f0'
    ctx.font = 'bold 11px Segoe UI, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(`Masa Suspendida (m = ${state.m} kg)`, -12, -31)

    ctx.restore()

    // 5. Ventana de corte mecánico (Rayos X) en la suspensión principal (eje delantero)
    // Muestra el resorte helicoidal y el amortiguador hidráulico comprimiéndose entre rueda y chasis
    const strutTopY = frontChassisY - 8
    const strutBotY = frontWheelY

    // Fondo de bahía de suspensión para máxima claridad visual
    ctx.save()
    ctx.fillStyle = 'rgba(9, 13, 22, 0.85)'
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.roundRect(frontWheelX - 30, strutTopY - 12, 60, strutBotY - strutTopY + 24, 10)
    ctx.fill()
    ctx.stroke()

    // Cilindro del amortiguador telescópico central (coloreado según temperatura del aceite)
    const midY = (strutTopY + strutBotY) / 2
    // Vástago superior
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(frontWheelX, strutTopY)
    ctx.lineTo(frontWheelX, midY + 8)
    ctx.stroke()

    // Botella inferior con aceite hidráulico
    const cylW = 12
    const cylH = Math.max(16, (strutBotY - strutTopY) * 0.55)
    ctx.fillStyle = state.bNominal > 0 ? getOilColorCSS(state.tempOil, 0.9) : '#334155'
    ctx.strokeStyle = '#94a3b8'
    ctx.lineWidth = 1.5
    ctx.fillRect(frontWheelX - cylW / 2, strutBotY - cylH, cylW, cylH)
    ctx.strokeRect(frontWheelX - cylW / 2, strutBotY - cylH, cylW, cylH)

    // Resorte helicoidal concéntrico (Ley de Hooke F_k = -kx)
    drawSpring2D(ctx, frontWheelX, strutTopY, frontWheelX, strutBotY, 6, 16, '#38bdf8', 2.6)

    // Suspensión trasera secundaria
    drawSpring2D(ctx, rearWheelX, rearChassisY, rearWheelX, rearWheelY, 5, 11, '#64748b', 2.0)
    ctx.restore()

    // 6. Dibujar Ruedas (Masa No Suspendida) con rotación según distancia s(t)
    const wheelAngle = (state.s / (wheelRadius / pxPerMeterY)) * 0.9
    drawWheel(ctx, rearWheelX, rearWheelY, wheelRadius, wheelAngle, false)
    drawWheel(ctx, frontWheelX, frontWheelY, wheelRadius, wheelAngle, true)

    // 7. Vectores de Fuerza en Vivo (F_k y F_b) al lado de la suspensión delantera
    drawForceArrow(ctx, frontWheelX + 42, frontChassisY, state.Fk, 6000, 55, '#38bdf8', 'F_k')
    drawForceArrow(ctx, frontWheelX + 98, frontChassisY, state.Fb, 6000, 55, '#f97316', 'F_b')

    // 8. Telemetría en esquina superior izquierda del Canvas 1
    ctx.save()
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)'
    ctx.strokeStyle = '#334155'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(12, 10, 235, 62, 6)
    ctx.fill()
    ctx.stroke()

    ctx.font = 'bold 11px Consolas, monospace'
    ctx.fillStyle = '#38bdf8'
    const xCm = (state.x * 100).toFixed(2)
    const yCm = (state.y * 100).toFixed(2)
    ctx.fillText(`x(t) Carrocería : ${xCm >= 0 ? '+' : ''}${xCm} cm`, 20, 28)
    ctx.fillStyle = '#cbd5e1'
    ctx.fillText(`y(t) Terreno    : ${yCm >= 0 ? '+' : ''}${yCm} cm`, 20, 44)
    ctx.fillStyle = '#10b981'
    ctx.fillText(
      `Velocidad       : ${state.vKmh} km/h (${state.timeScale.toFixed(2)}x)`,
      20,
      60
    )
    ctx.restore()
  }

  function drawWheel(ctx, x, y, r, angle, isInstrumented) {
    ctx.save()
    ctx.translate(x, y)

    // Neumático de caucho
    ctx.beginPath()
    ctx.arc(0, 0, r, 0, Math.PI * 2)
    ctx.fillStyle = '#0f172a'
    ctx.fill()
    ctx.lineWidth = 5
    ctx.strokeStyle = isInstrumented ? '#334155' : '#1e293b'
    ctx.stroke()

    // Rin metálico con radios que giran con el avance del carro
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2)
    ctx.strokeStyle = isInstrumented ? '#38bdf8' : '#94a3b8'
    ctx.lineWidth = 2
    ctx.stroke()

    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6)
      ctx.stroke()
    }

    // Eje central
    ctx.beginPath()
    ctx.arc(0, 0, 4.5, 0, Math.PI * 2)
    ctx.fillStyle = '#f8fafc'
    ctx.fill()

    ctx.restore()
  }

  // ============================================================================
  // 8. DIBUJO EN CANVAS 2: CORTE TRANSVERSAL DEL AMORTIGUADOR HIDRÁULICO
  // ============================================================================
  function renderDamperCanvas() {
    const c = canvases.damper
    const ctx = ctxs.damper
    const W = c._logicalW || 340
    const H = c._logicalH || 240

    ctx.clearRect(0, 0, W, H)

    const centerX = W * 0.44
    const topMountY = 24
    const botMountY = H - 22
    const totalAvailH = botMountY - topMountY

    // Elongación relativa z = x - y (limitada visualmente para el diagrama en corte)
    const zClamped = Math.max(-0.14, Math.min(0.14, state.x - state.y))
    const vRel = state.vx - state.vy

    // Geometría del cilindro hidráulico interno
    const cylWidth = 64
    const cylTopY = topMountY + 34
    const cylBotY = botMountY - 16
    const cylHeight = cylBotY - cylTopY

    // Posición vertical del pistón dentro de la cámara de aceite según z = x - y
    const pistonCenterY = cylTopY + cylHeight * 0.5 - (zClamped / 0.16) * (cylHeight * 0.36)
    const pistonH = 14

    // 1. Flechas exteriores de disipación de calor por CONVECCIÓN (cuando T > 28°C)
    if (state.tempOil > 28.0 && state.bNominal > 0) {
      const heatIntensity = Math.min(1.0, (state.tempOil - 25) / 65)
      ctx.save()
      ctx.strokeStyle = `rgba(249, 115, 22, ${0.25 + 0.65 * heatIntensity})`
      ctx.fillStyle = `rgba(249, 115, 22, ${0.35 + 0.65 * heatIntensity})`
      ctx.lineWidth = 1.8

      const wavePositions = [
        cylTopY + cylHeight * 0.25,
        cylTopY + cylHeight * 0.55,
        cylTopY + cylHeight * 0.8
      ]
      wavePositions.forEach((wy, idx) => {
        const animShift = (state.t * 18 + idx * 7) % 14
        // Lado izquierdo y derecho
        ;[-1, 1].forEach((side) => {
          const sx = centerX + side * (cylWidth / 2 + 24 + animShift)
          ctx.beginPath()
          ctx.moveTo(sx - side * 10, wy)
          ctx.quadraticCurveTo(sx - side * 5, wy - 4, sx, wy)
          ctx.quadraticCurveTo(sx + side * 5, wy + 4, sx + side * 10, wy)
          ctx.stroke()

          // Punta de flecha térmica
          ctx.beginPath()
          ctx.moveTo(sx + side * 13, wy)
          ctx.lineTo(sx + side * 8, wy - 3)
          ctx.lineTo(sx + side * 8, wy + 3)
          ctx.closePath()
          ctx.fill()
        })
      })
      ctx.restore()
    }

    // 2. Resorte Helicoidal Concéntrico Exterior (Parte trasera de las espiras)
    drawSpring2D(
      ctx,
      centerX,
      topMountY + 8,
      centerX,
      botMountY - 8,
      7,
      cylWidth * 0.76,
      'rgba(56, 189, 248, 0.78)',
      4.2
    )

    // 3. Cilindro Metálico del Amortiguador (Corte Transversal)
    ctx.save()
    // Pared metálica exterior del cilindro (actúa como intercambiador de calor)
    ctx.fillStyle = '#1e293b'
    ctx.strokeStyle = '#94a3b8'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.roundRect(centerX - cylWidth / 2 - 4, cylTopY - 4, cylWidth + 8, cylHeight + 8, 6)
    ctx.fill()
    ctx.stroke()

    // Cámara interna con Fluido Hidráulico (Aceite)
    if (state.bNominal > 0) {
      const oilGrad = ctx.createLinearGradient(
        centerX - cylWidth / 2,
        cylTopY,
        centerX + cylWidth / 2,
        cylBotY
      )
      oilGrad.addColorStop(0, getOilColorCSS(state.tempOil, 0.88))
      oilGrad.addColorStop(0.5, getOilColorCSS(state.tempOil + 6, 0.95))
      oilGrad.addColorStop(1, getOilColorCSS(state.tempOil, 0.88))
      ctx.fillStyle = oilGrad
    } else {
      // Modo "Sin Amortiguador (b = 0)"
      ctx.fillStyle = '#0f172a'
    }
    ctx.fillRect(centerX - cylWidth / 2, cylTopY, cylWidth, cylHeight)

    // 4. Partículas de fluido hidráulico y chorros por las microválvulas
    if (state.bNominal > 0) {
      const speedFactor = Math.min(1.0, Math.abs(vRel) / 0.8)
      ctx.fillStyle =
        state.tempOil > T_MAX_SAFE ? 'rgba(254, 226, 226, 0.85)' : 'rgba(255, 255, 255, 0.65)'
      for (let i = 0; i < oilParticles.length; i++) {
        const p = oilParticles[i]
        const px = centerX + p.rx * (cylWidth - 8)
        const py = cylTopY + 5 + p.ry * (cylHeight - 10)
        ctx.beginPath()
        ctx.arc(px, py, p.size, 0, Math.PI * 2)
        ctx.fill()
      }

      // Chorros de alta velocidad cruzando los 2 orificios (microválvulas) del pistón
      if (speedFactor > 0.03) {
        const orificeOffsets = [-cylWidth * 0.22, cylWidth * 0.22]
        const jetLen = Math.sign(-vRel) * Math.min(36, 10 + Math.abs(vRel) * 32)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
        ctx.lineWidth = 2.2
        orificeOffsets.forEach((ox) => {
          ctx.beginPath()
          ctx.moveTo(centerX + ox, pistonCenterY - jetLen * 0.3)
          ctx.lineTo(centerX + ox, pistonCenterY + jetLen)
          ctx.stroke()
        })
      }
    } else {
      ctx.fillStyle = '#94a3b8'
      ctx.font = 'bold 10px Consolas, monospace'
      ctx.textAlign = 'center'
      ctx.fillText('SIN FLUIDO', centerX, cylTopY + cylHeight * 0.32)
      ctx.fillText('(b = 0)', centerX, cylTopY + cylHeight * 0.42)
    }

    // 5. Vástago Cromado y Pistón con Microválvulas (Orificios de restricción)
    // Vástago
    ctx.fillStyle = '#e2e8f0'
    ctx.strokeStyle = '#475569'
    ctx.lineWidth = 1.5
    ctx.fillRect(centerX - 5, topMountY + 8, 10, pistonCenterY - (topMountY + 8))
    ctx.strokeRect(centerX - 5, topMountY + 8, 10, pistonCenterY - (topMountY + 8))

    // Cabeza del pistón dividida en 3 bloques para dejar visibles los 2 canales de microválvulas
    const pTop = pistonCenterY - pistonH / 2
    const pLeft = centerX - cylWidth / 2 + 1
    ctx.fillStyle = '#334155'
    ctx.strokeStyle = '#cbd5e1'
    ctx.lineWidth = 1.5

    // Bloque izquierdo, central y derecho del pistón (dejando 2 orificios de paso)
    const blockW = (cylWidth - 14) / 3
    ctx.fillRect(pLeft, pTop, blockW, pistonH)
    ctx.strokeRect(pLeft, pTop, blockW, pistonH)

    ctx.fillRect(centerX - blockW / 2, pTop, blockW, pistonH)
    ctx.strokeRect(centerX - blockW / 2, pTop, blockW, pistonH)

    ctx.fillRect(centerX + cylWidth / 2 - 1 - blockW, pTop, blockW, pistonH)
    ctx.strokeRect(centerX + cylWidth / 2 - 1 - blockW, pTop, blockW, pistonH)

    // Soportes superior (Carrocería) e inferior (Rueda)
    ctx.fillStyle = '#0284c7'
    ctx.fillRect(centerX - 28, topMountY, 56, 9)
    ctx.fillStyle = '#475569'
    ctx.fillRect(centerX - 28, botMountY - 9, 56, 9)
    ctx.restore()

    // 6. Anotaciones Técnicas Laterales en el Canvas del Amortiguador
    const labelX = centerX + cylWidth * 0.85 + 8
    ctx.save()
    ctx.font = '10px Segoe UI, sans-serif'
    ctx.fillStyle = '#cbd5e1'

    // Etiqueta Resorte
    ctx.fillStyle = '#38bdf8'
    ctx.fillText('Resorte Helicoidal', labelX, cylTopY + 12)
    ctx.fillStyle = '#94a3b8'
    ctx.fillText(`F_k = ${Math.round(state.Fk)} N`, labelX, cylTopY + 24)

    // Etiqueta Pistón y Microválvulas
    ctx.fillStyle = '#f8fafc'
    ctx.fillText('Pistón + Microválvulas', labelX, pistonCenterY - 2)
    ctx.fillStyle = '#f97316'
    ctx.fillText(`F_b = ${Math.round(state.Fb)} N`, labelX, pistonCenterY + 11)

    // Etiqueta Aceite y Temperatura
    ctx.fillStyle = getOilColorCSS(state.tempOil)
    ctx.font = 'bold 11px Consolas, monospace'
    ctx.fillText(`Aceite: ${state.tempOil.toFixed(1)}°C`, labelX, cylBotY - 16)
    ctx.font = '10px Segoe UI, sans-serif'
    ctx.fillStyle = '#94a3b8'
    ctx.fillText(
      state.tempOil >= T_MAX_SAFE && state.bNominal > 0
        ? '⚠️ Fading activo'
        : 'Convección ext.',
      labelX,
      cylBotY - 3
    )
    ctx.restore()
  }

  // ============================================================================
  // 9. DIBUJO DE LAS 3 GRÁFICAS EN TIEMPO REAL (60 FPS, BUFFER CIRCULAR)
  // ============================================================================
  function renderCharts() {
    renderPositionChart()
    renderForcesChart()
    renderThermoChart()
  }

  function drawChartGrid(ctx, W, H, padL, padR, padT, padB, yMin, yMax, unitLabel) {
    const plotW = W - padL - padR
    const plotH = H - padT - padB

    ctx.save()
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.45)'
    ctx.lineWidth = 1
    ctx.fillStyle = '#64748b'
    ctx.font = '10px Consolas, monospace'
    ctx.textAlign = 'right'

    const steps = 4
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps
      const py = padT + frac * plotH
      const val = yMax - frac * (yMax - yMin)

      ctx.beginPath()
      ctx.moveTo(padL, py)
      ctx.lineTo(W - padR, py)
      ctx.stroke()

      ctx.fillText(`${val.toFixed(val % 1 === 0 ? 0 : 1)}${unitLabel}`, padL - 5, py + 3)
    }

    // Línea cero destacada si 0 está en el rango
    if (yMin < 0 && yMax > 0) {
      const zeroY = padT + (yMax / (yMax - yMin)) * plotH
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)'
      ctx.beginPath()
      ctx.moveTo(padL, zeroY)
      ctx.lineTo(W - padR, zeroY)
      ctx.stroke()
    }
    ctx.restore()
  }

  // Gráfica 1: Posición vertical x(t), Terreno y(t) y Envolvente Exponencial ±A·e^(-(b/2m)t)
  function renderPositionChart() {
    const c = canvases.chartPos
    const ctx = ctxs.chartPos
    const W = c._logicalW || 360
    const H = c._logicalH || 170

    ctx.clearRect(0, 0, W, H)

    const padL = 44,
      padR = 10,
      padT = 10,
      padB = 18
    const plotW = W - padL - padR
    const plotH = H - padT - padB

    const maxRangeCm = 16
    drawChartGrid(ctx, W, H, padL, padR, padT, padB, -maxRangeCm, maxRangeCm, 'cm')

    if (history.length < 2) return

    const tEnd = history[history.length - 1].t
    const tStart = Math.max(0, tEnd - CHART_HISTORY_SECONDS)

    const mapX = (tVal) => padL + ((tVal - tStart) / CHART_HISTORY_SECONDS) * plotW
    const mapY = (cmVal) => {
      const clamped = Math.max(-maxRangeCm, Math.min(maxRangeCm, cmVal))
      return padT + ((maxRangeCm - clamped) / (2 * maxRangeCm)) * plotH
    }

    // 1. Perfil del Terreno y(t) [Gris punteado]
    ctx.save()
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const pt = history[i]
      const px = mapX(pt.t)
      const py = mapY(pt.yCm)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.65)'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // 2. Envolvente Exponencial ±A·e^(-(b/2m)t) (visible en régimen subamortiguado o sin amortiguador)
    const reg = classifyCurrentRegime()
    if (reg.id === 'under' || reg.id === 'none') {
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = 'rgba(16, 185, 129, 0.75)'
      ctx.lineWidth = 1.3

      // Envolvente superior +E(t)
      ctx.beginPath()
      for (let i = 0; i < history.length; i++) {
        const pt = history[i]
        const px = mapX(pt.t)
        const py = mapY(pt.envCm)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()

      // Envolvente inferior -E(t)
      ctx.beginPath()
      for (let i = 0; i < history.length; i++) {
        const pt = history[i]
        const px = mapX(pt.t)
        const py = mapY(-pt.envCm)
        if (i === 0) ctx.moveTo(px, py)
        else ctx.lineTo(px, py)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }

    // 3. Posición de la Carrocería x(t) [Azul Cian Brillante]
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const pt = history[i]
      const px = mapX(pt.t)
      const py = mapY(pt.xCm)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 2.2
    ctx.stroke()
    ctx.restore()
  }

  // Gráfica 2: Fuerzas Dinámicas F_k(t) vs F_b(t)
  function renderForcesChart() {
    const c = canvases.chartForces
    const ctx = ctxs.chartForces
    const W = c._logicalW || 360
    const H = c._logicalH || 170

    ctx.clearRect(0, 0, W, H)

    const padL = 48,
      padR = 10,
      padT = 10,
      padB = 18
    const plotW = W - padL - padR
    const plotH = H - padT - padB

    const maxForceK = 6.0 // en kN para lectura limpia
    drawChartGrid(ctx, W, H, padL, padR, padT, padB, -maxForceK, maxForceK, 'kN')

    if (history.length < 2) return

    const tEnd = history[history.length - 1].t
    const tStart = Math.max(0, tEnd - CHART_HISTORY_SECONDS)

    const mapX = (tVal) => padL + ((tVal - tStart) / CHART_HISTORY_SECONDS) * plotW
    const mapY = (kNVal) => {
      const clamped = Math.max(-maxForceK, Math.min(maxForceK, kNVal))
      return padT + ((maxForceK - clamped) / (2 * maxForceK)) * plotH
    }

    ctx.save()
    // Fuerza elástica del resorte F_k (kN)
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const pt = history[i]
      const px = mapX(pt.t)
      const py = mapY(pt.Fk / 1000)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 2.0
    ctx.stroke()

    // Fuerza viscosa del amortiguador F_b (kN)
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const pt = history[i]
      const px = mapX(pt.t)
      const py = mapY(pt.Fb / 1000)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = '#f97316'
    ctx.lineWidth = 2.0
    ctx.stroke()
    ctx.restore()
  }

  // Gráfica 3: Temperatura T(t) y Calor Disipado Q(t)
  function renderThermoChart() {
    const c = canvases.chartThermo
    const ctx = ctxs.chartThermo
    const W = c._logicalW || 360
    const H = c._logicalH || 170

    ctx.clearRect(0, 0, W, H)

    const padL = 44,
      padR = 38,
      padT = 10,
      padB = 18
    const plotW = W - padL - padR
    const plotH = H - padT - padB

    const tMinC = 20
    const tMaxC = 130
    drawChartGrid(ctx, W, H, padL, padR, padT, padB, tMinC, tMaxC, '°C')

    // Línea roja de umbral de Fading Térmico (90°C)
    const fadeY = padT + ((tMaxC - T_MAX_SAFE) / (tMaxC - tMinC)) * plotH
    ctx.save()
    ctx.setLineDash([5, 4])
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)'
    ctx.lineWidth = 1.3
    ctx.beginPath()
    ctx.moveTo(padL, fadeY)
    ctx.lineTo(W - padR, fadeY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#f87171'
    ctx.font = '9px Consolas, monospace'
    ctx.fillText('Umbral Fading (90°C)', padL + 6, fadeY - 4)
    ctx.restore()

    if (history.length < 2) return

    const tEnd = history[history.length - 1].t
    const tStart = Math.max(0, tEnd - CHART_HISTORY_SECONDS)

    const mapX = (tVal) => padL + ((tVal - tStart) / CHART_HISTORY_SECONDS) * plotW
    const mapYTemp = (tempVal) => {
      const clamped = Math.max(tMinC, Math.min(tMaxC, tempVal))
      return padT + ((tMaxC - clamped) / (tMaxC - tMinC)) * plotH
    }

    // Escala dinámica para el Calor Q (kJ) en el eje derecho
    const maxQ = Math.max(2.0, history[history.length - 1].qKJ * 1.25)
    const mapYQ = (qVal) => {
      const clamped = Math.max(0, Math.min(maxQ, qVal))
      return padT + ((maxQ - clamped) / maxQ) * plotH
    }

    // Etiquetas del eje derecho para Q (kJ)
    ctx.save()
    ctx.fillStyle = '#facc15'
    ctx.font = '9px Consolas, monospace'
    ctx.textAlign = 'left'
    ctx.fillText(`${maxQ.toFixed(1)}kJ`, W - padR + 3, padT + 6)
    ctx.fillText(`0kJ`, W - padR + 3, H - padB)

    // Curva de Calor Acumulado Q(t) [Amarillo]
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const pt = history[i]
      const px = mapX(pt.t)
      const py = mapYQ(pt.qKJ)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = '#facc15'
    ctx.lineWidth = 1.8
    ctx.stroke()

    // Curva de Temperatura del Aceite T(t) [Naranja/Rojo]
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const pt = history[i]
      const px = mapX(pt.t)
      const py = mapYTemp(pt.temp)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.strokeStyle = '#ef4444'
    ctx.lineWidth = 2.3
    ctx.stroke()
    ctx.restore()
  }

  // ============================================================================
  // 10. EVENTOS DE USUARIO Y BUCLE PRINCIPAL (requestAnimationFrame)
  // ============================================================================
  function resetSimulation() {
    state.t = 0
    state.s = 0
    state.x = 0
    state.vx = 0
    state.ax = 0
    state.y = 0
    state.vy = 0
    state.yRear = 0
    state.Fk = 0
    state.Fb = 0
    state.tempOil = T_AMBIENT
    state.qTotalJ = 0
    state.powerViscW = 0
    state.powerConvW = 0
    state.envAmp = 0
    state.envT0 = 0
    state.manualBumps = []
    history.length = 0
    syncControlsAndHUD()
  }

  function setupEventListeners() {
    // Botones de Presets de Régimen
    dom.presetBtns.none.addEventListener('click', () => applyRegimePreset('none'))
    dom.presetBtns.under.addEventListener('click', () => applyRegimePreset('under'))
    dom.presetBtns.critical.addEventListener('click', () => applyRegimePreset('critical'))
    dom.presetBtns.over.addEventListener('click', () => applyRegimePreset('over'))

    // Botones de acción
    dom.btnBump.addEventListener('click', () => {
      if (state.paused) {
        state.paused = false
        dom.btnPause.textContent = '⏸ Pausar'
      }
      triggerManualBump()
    })

    dom.btnPause.addEventListener('click', () => {
      state.paused = !state.paused
      dom.btnPause.textContent = state.paused ? '▶ Reanudar' : '⏸ Pausar'
    })

    dom.btnReset.addEventListener('click', resetSimulation)

    dom.btnCoolOil.addEventListener('click', () => {
      state.tempOil = T_AMBIENT
      state.qTotalJ = 0
      syncControlsAndHUD()
    })

    dom.btnHeatOil.addEventListener('click', () => {
      state.tempOil = 96.0
      syncControlsAndHUD()
      triggerManualBump()
    })

    // Cámara lenta (Slider + Botones rápidos)
    dom.sliderTimeScale.addEventListener('input', (e) => {
      state.timeScale = parseFloat(e.target.value)
      dom.pillBtns.forEach((btn) => {
        btn.classList.toggle(
          'active',
          Math.abs(parseFloat(btn.dataset.timescale) - state.timeScale) < 0.02
        )
      })
      syncControlsAndHUD()
    })

    dom.pillBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const ts = parseFloat(btn.dataset.timescale)
        state.timeScale = ts
        dom.sliderTimeScale.value = ts
        dom.pillBtns.forEach((b) => b.classList.toggle('active', b === btn))
        syncControlsAndHUD()
      })
    })

    // Sliders físicos
    dom.sliderB.addEventListener('input', (e) => {
      state.bNominal = parseFloat(e.target.value)
      syncControlsAndHUD()
    })

    dom.sliderK.addEventListener('input', (e) => {
      state.k = parseFloat(e.target.value)
      syncControlsAndHUD()
    })

    dom.sliderM.addEventListener('input', (e) => {
      state.m = parseFloat(e.target.value)
      syncControlsAndHUD()
    })

    dom.sliderV.addEventListener('input', (e) => {
      state.vKmh = parseFloat(e.target.value)
      syncControlsAndHUD()
    })

    dom.sliderBumpH.addEventListener('input', (e) => {
      state.bumpHeightCm = parseFloat(e.target.value)
      syncControlsAndHUD()
    })

    // Selectores
    dom.selectTerrain.addEventListener('change', (e) => {
      state.terrainType = e.target.value
      if (state.terrainType === 'flat') {
        triggerManualBump()
      }
    })

    dom.selectFluid.addEventListener('change', (e) => {
      state.fluidKey = e.target.value
      syncControlsAndHUD()
    })

    dom.selectThermalScale.addEventListener('change', (e) => {
      state.thermalScale = parseFloat(e.target.value)
      syncControlsAndHUD()
    })

    dom.chkFading.addEventListener('change', (e) => {
      state.fadingEnabled = e.target.checked
      syncControlsAndHUD()
    })
  }

  // Bucle principal de animación con sub-stepping para estabilidad numérica absoluta
  let lastFrameTime = performance.now()

  function mainLoop(now) {
    const rawDt = Math.min(0.05, Math.max(0.001, (now - lastFrameTime) / 1000))
    lastFrameTime = now

    if (!state.paused) {
      const scaledDt = rawDt * state.timeScale
      const subSteps = 6
      const stepDt = scaledDt / subSteps

      for (let i = 0; i < subSteps; i++) {
        stepPhysicsRK4(stepDt)
      }

      // Registrar muestra para las gráficas con alta resolución temporal
      chartSampleAccum += scaledDt
      if (chartSampleAccum >= 0.005) {
        chartSampleAccum = 0

        // Calcular valor de la envolvente teórica A0 * e^(-(b/2m)*(t - t0))
        const decayRate = state.bEffective / (2 * state.m)
        const dtEnv = Math.max(0, state.t - state.envT0)
        const envNowM = state.envAmp * Math.exp(-decayRate * dtEnv)

        history.push({
          t: state.t,
          xCm: state.x * 100,
          yCm: state.y * 100,
          envCm: envNowM * 100,
          Fk: state.Fk,
          Fb: state.Fb,
          temp: state.tempOil,
          qKJ: state.qTotalJ / 1000
        })

        // Recortar muestras más antiguas que la ventana de tiempo de la gráfica
        const cutoffT = state.t - CHART_HISTORY_SECONDS - 0.5
        while (history.length > 0 && history[0].t < cutoffT) {
          history.shift()
        }
      }

      syncControlsAndHUD()
    }

    renderCarCanvas()
    renderDamperCanvas()
    renderCharts()

    requestAnimationFrame(mainLoop)
  }

  // Inicialización
  resizeAllCanvases()
  setupEventListeners()
  syncControlsAndHUD()
  requestAnimationFrame(mainLoop)
})()
