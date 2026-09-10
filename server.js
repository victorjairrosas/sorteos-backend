// server.js
// Este es el programa que corre 24/7 y hace todo el trabajo real:
// 1) Crea la orden de pago en Mercado Pago cuando alguien quiere comprar boletos.
// 2) Escucha cuando Mercado Pago confirma que el pago sí se hizo (webhook).
// 3) Lleva la cuenta de cuántos boletos van vendidos.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // sirve index.html, estilos.css, etc.

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

// ── 1) Ver disponibilidad de boletos (para la barra de progreso) ──────────
app.get('/api/estado', (req, res) => {
  const rifa = db.getRifaConfig();
  const compras = db.getCompras();
  const vendidos = db.boletosVendidos(compras);

  res.json({
    titulo: rifa.titulo,
    precio: rifa.precio,
    totalBoletos: rifa.totalBoletos,
    boletosVendidos: vendidos,
  });
});

// ── 2) Crear una preferencia de pago (el usuario quiere comprar) ──────────
app.post('/api/crear-preferencia', async (req, res) => {
  try {
    const { nombre, email, cantidad } = req.body;

    if (!nombre || !email || !cantidad || cantidad < 1) {
      return res.status(400).json({ error: 'Faltan datos: nombre, email y cantidad son obligatorios.' });
    }

    const rifa = db.getRifaConfig();
    const compras = db.getCompras();
    const comprometidos = db.boletosComprometidos(compras);

    if (comprometidos + cantidad > rifa.totalBoletos) {
      return res.status(409).json({ error: 'Ya no quedan suficientes boletos disponibles.' });
    }

    const compraId = uuidv4();
    const nuevaCompra = {
      id: compraId,
      nombre,
      email,
      cantidad: Number(cantidad),
      estado: 'pendiente',
      preferenceId: null,
      paymentId: null,
      numerosAsignados: [],
      creadoEn: new Date().toISOString(),
    };

    compras.push(nuevaCompra);
    db.saveCompras(compras);

    const preference = new Preference(mpClient);
    const resultado = await preference.create({
      body: {
        items: [
          {
            id: rifa.id,
            title: `${rifa.titulo} — ${cantidad} boleto(s)`,
            quantity: 1,
            unit_price: rifa.precio * Number(cantidad),
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

    // Guardamos el id de la preferencia por si necesitamos consultarla luego
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
  // Respondemos rápido siempre (Mercado Pago solo necesita un 200 OK)
  res.sendStatus(200);

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
      // Evita procesar el mismo pago dos veces
      if (compra.estado === 'aprobado') return;

      compra.paymentId = pago.id;

      if (pago.status === 'approved') {
        const rifa = db.getRifaConfig();
        const vendidosAntes = db.boletosVendidos(compras);
        const numeros = [];
        for (let i = 1; i <= compra.cantidad; i++) {
          numeros.push(vendidosAntes + i);
        }
        compra.estado = 'aprobado';
        compra.numerosAsignados = numeros;
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

// ── 4) Consultar el resultado de una compra (para mostrar el número asignado) ──
app.get('/api/compra/:id', (req, res) => {
  const compras = db.getCompras();
  const compra = compras.find((c) => c.id === req.params.id);
  if (!compra) return res.status(404).json({ error: 'No encontrada' });
  res.json(compra);
});

app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en ${BASE_URL}`);
});
