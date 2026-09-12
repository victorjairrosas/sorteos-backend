// db.js
// Esta es nuestra "base de datos" simple: un archivo JSON en disco.
// Ahora cada compra guarda los NÚMEROS exactos de boleto que se
// seleccionaron (no solo una cantidad), para poder mostrar una
// cuadrícula donde la gente elige boletos específicos.

const fs = require('fs');
const path = require('path');

const COMPRAS_PATH = path.join(__dirname, 'compras.json');
const RIFA_PATH = path.join(__dirname, 'rifa-config.json');

const RESERVA_MINUTOS = 30; // minutos que "apartamos" un boleto mientras alguien paga

function getRifaConfig() {
  return JSON.parse(fs.readFileSync(RIFA_PATH, 'utf-8'));
}

function getCompras() {
  return JSON.parse(fs.readFileSync(COMPRAS_PATH, 'utf-8'));
}

function saveCompras(compras) {
  fs.writeFileSync(COMPRAS_PATH, JSON.stringify(compras, null, 2));
}

// Cola simple para que dos escrituras nunca se pisen entre sí
let cola = Promise.resolve();
function conCandado(fn) {
  cola = cola.then(fn, fn);
  return cola;
}

// Números ya PAGADOS Y CONFIRMADOS
function numerosVendidos(compras) {
  const set = new Set();
  compras.forEach((c) => {
    if (c.estado === 'aprobado') {
      (c.numeros || []).forEach((n) => set.add(n));
    }
  });
  return set;
}

// Números vendidos + números que alguien está pagando ahora mismo
// (los "apartamos" temporalmente para que nadie más los elija).
// Si una compra pendiente ya es muy vieja (se le olvidó pagar), la ignoramos.
function numerosOcupados(compras) {
  const ahora = Date.now();
  const limiteMs = RESERVA_MINUTOS * 60 * 1000;
  const set = new Set();
  compras.forEach((c) => {
    if (c.estado === 'aprobado') {
      (c.numeros || []).forEach((n) => set.add(n));
    } else if (c.estado === 'pendiente') {
      const edad = ahora - new Date(c.creadoEn).getTime();
      if (edad < limiteMs) {
        (c.numeros || []).forEach((n) => set.add(n));
      }
    }
  });
  return set;
}

module.exports = {
  getRifaConfig,
  getCompras,
  saveCompras,
  conCandado,
  numerosVendidos,
  numerosOcupados,
};
