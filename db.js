// db.js
// Esta es nuestra "base de datos" simple: un archivo JSON en disco.
// Para el tamaño de una rifa (miles de boletos, no millones) esto es
// perfectamente real y funcional. Más adelante, si el negocio crece,
// se puede migrar a una base de datos como PostgreSQL sin cambiar
// mucho el resto del código.

const fs = require('fs');
const path = require('path');

   const COMPRAS_PATH = path.join(__dirname, 'compras.json');
   const RIFA_PATH = path.join(__dirname, 'rifa-config.json');

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
// (por ejemplo, si llegan dos confirmaciones de pago casi al mismo tiempo).
let cola = Promise.resolve();
function conCandado(fn) {
  cola = cola.then(fn, fn);
  return cola;
}

// Boletos ya pagados y confirmados
function boletosVendidos(compras) {
  return compras
    .filter((c) => c.estado === 'aprobado')
    .reduce((total, c) => total + c.cantidad, 0);
}

// Boletos vendidos + boletos que alguien está pagando en este momento
// (los "apartamos" mientras se completa el pago para no vender de más)
function boletosComprometidos(compras) {
  return compras
    .filter((c) => c.estado === 'aprobado' || c.estado === 'pendiente')
    .reduce((total, c) => total + c.cantidad, 0);
}

module.exports = {
  getRifaConfig,
  getCompras,
  saveCompras,
  conCandado,
  boletosVendidos,
  boletosComprometidos,
};
