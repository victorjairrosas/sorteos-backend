// server.js
// Este es el programa que corre 24/7 y hace todo el trabajo real:
// 1) Muestra qué boletos (por número) están libres, apartados o vendidos.
// 2) Crea la orden de pago en Mercado Pago para los números que elegiste.
// 3) Escucha cuando Mercado Pago confirma que el pago sí se hizo (webhook).

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // sirve index.html, estilos.css, etc.

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

if (!process.env.MP_ACCESS_TOKEN) {
  console.warn(
    '⚠️  No encontré MP_ACCESS_TOKEN en tu archivo .env — copia .env.example a .env y pon tu Access Token de Mercado Pago.'
  );
}

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || '',
});

// ── 1) Ver el estado de todos los boletos (para pintar la cuadrícula) ─────
app.get('/api/estado', (req, res) => {
  const rifa = db.getRifaConfig();
  const compras = db.getCompras();
  const vendidos = db.numerosVendidos(compras);
  const ocupados = db.numerosOcupados(compras);
  // "reservados" = ocupados ahora mismo pero que todavía no están vendidos
  const reservados = [...ocupados].filter((n) => !vendidos.has(n));

  res.json({
    titulo: rifa.titulo,
    precio: rifa.precio,
    totalBoletos: rifa.totalBoletos,
    vendidosNumeros: [...vendidos],
    reservadosNumeros: reservados,
  });
});

// ── 2) Reservar boletos específicos y crear la orden de pago ──────────────
app.post('/api/reservar-boletos', async (req, res) => {
  try {
    const { nombre, email, numeros } = req.body;

    if (!nombre || !email || !Array.isArray(numeros) || numeros.length === 0) {
      return res.status(400).json({ error: 'Faltan datos: nombre, email y al menos un número de boleto.' });
    }

    const rifa = db.getRifaConfig();
    const numerosLimpios = [...new Set(numeros.map(Number))].filter(
      (n) => Number.isInteger(n) && n >= 1 && n <= rifa.totalBoletos
    );

    if (numerosLimpios.length === 0) {
      return res.status(400).json({ error: 'Los números de boleto no son válidos.' });
    }

    const compras = db.getCompras();
    const ocupados = db.numerosOcupados(compras);
    const conflicto = numerosLimpios.filter((n) => ocupados.has(n));

    if (conflicto.length > 0) {
      return res.status(409).json({
        error: 'Algunos de esos boletos ya no están disponibles.',
        numerosOcupados: conflicto,
      });
    }

    const compraId = uuidv4();
    const nuevaCompra = {
      id: compraId,
      nombre,
      email,
      numeros: numerosLimpios,
      estado: 'pendiente',
      preferenceId: null,
      paymentId: null,
      creadoEn: new Date().toISOString(),
    };

    compras.push(nuevaCompra);
    db.saveCompras(compras);

    const listaNumeros = numerosLimpios
      .slice(0, 5)
      .map((n) => '#' + String(n).padStart(String(rifa.totalBoletos).length, '0'))
      .join(', ');
    const extra = numerosLimpios.length > 5 ? ` y ${numerosLimpios.length - 5} más` : '';

    const preference = new Preference(mpClient);
    const resultado = await preference.create({
      body: {
        items: [
          {
            id: rifa.id,
            title: `${rifa.titulo} — boletos ${listaNumeros}${extra}`,
            quantity: numerosLimpios.length,
            unit_price: rifa.precio,
            currency_id: 'MXN',
          },
        ],
        payer: { name: nombre, email },
        external_reference: compraId,
        notification_url: `${BASE_URL}/api/webhook`,
        back_urls: {
          success: `${BASE_URL}/gracias.html`,
          failure: `${BASE_URL}/error.html`,
          pending: `${BASE_URL}/pendiente.html`,
        },
        auto_return: 'approved',
      },
    });

    const compraActualizada = db.getCompras();
    const idx = compraActualizada.findIndex((c) => c.id === compraId);
    compraActualizada[idx].preferenceId = resultado.id;
    db.saveCompras(compraActualizada);

    res.json({ init_point: resultado.init_point });
  } catch (err) {
    console.error('Error creando preferencia:', err);
    res.status(500).json({ error: 'No se pudo iniciar el pago. Intenta de nuevo.' });
  }
});

// ── 3) Webhook: Mercado Pago nos avisa aquí si el pago se aprobó ──────────
app.post('/api/webhook', async (req, res) => {
  res.sendStatus(200); // Mercado Pago solo necesita un 200 OK rápido

  try {
    const paymentId = req.body?.data?.id || req.query['data.id'];
    const tipo = req.body?.type || req.query.type;
    if (tipo !== 'payment' || !paymentId) return;

    const payment = new Payment(mpClient);
    const pago = await payment.get({ id: paymentId });

    const compraId = pago.external_reference;
    if (!compraId) return;

    await db.conCandado(() => {
      const compras = db.getCompras();
      const idx = compras.findIndex((c) => c.id === compraId);
      if (idx === -1) return;

      const compra = compras[idx];
      if (compra.estado === 'aprobado') return; // ya procesado, no lo dupliques

      compra.paymentId = pago.id;

      if (pago.status === 'approved') {
        compra.estado = 'aprobado';
      } else if (pago.status === 'rejected') {
        compra.estado = 'rechazado';
      } else {
        compra.estado = 'pendiente';
      }

      db.saveCompras(compras);
    });
  } catch (err) {
    console.error('Error procesando webhook:', err);
  }
});

// ── 4) Consultar el resultado de una compra ────────────────────────────────
app.get('/api/compra/:id', (req, res) => {
  const compras = db.getCompras();
  const compra = compras.find((c) => c.id === req.params.id);
  if (!compra) return res.status(404).json({ error: 'No encontrada' });
  res.json(compra);
});

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en ${BASE_URL}`);
});
