require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const PDFDocument = require("pdfkit");

const PORT = process.env.PORT || 3000;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const CLAUDE_MODEL_REINTENTO = process.env.CLAUDE_MODEL_REINTENTO || "claude-sonnet-5";

const CATEGORIAS = [
  "Materiales", "Combustible", "Alimentacion", "Herramientas",
  "Transporte", "Servicios", "Papeleria", "Mantenimiento", "Otros",
];

// No se cargan facturas de fecha anterior a este mes; una fecha leida antes
// de esto casi siempre es un error de lectura (OCR) y se descarta.
const FECHA_MINIMA_FACTURAS = "2026-07-01";

const LOGO_PATH = path.join(__dirname, "..", "frontend", "icons", "logo-full.png");
const LOGO_BUFFER = fs.existsSync(LOGO_PATH) ? fs.readFileSync(LOGO_PATH) : null;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

const upload = multer({ limits: { fileSize: 12 * 1024 * 1024 } });

function requireAppsScriptUrl() {
  if (!APPS_SCRIPT_URL) throw new Error("Falta APPS_SCRIPT_URL");
}

function fmtCOP_(n) {
  return "$" + Math.round(Number(n) || 0).toLocaleString("es-CO");
}

function fmtFechaCorta_(iso) {
  if (!iso) return "";
  const texto = String(iso).slice(0, 10);
  const [y, m, d] = texto.split("-");
  return y && m && d ? `${d}/${m}/${y}` : texto;
}

async function descargarImagenDrive_(fotoUrl) {
  const m = (fotoUrl || "").match(/\/d\/([^/]+)\//);
  if (!m) return null;
  try {
    const imgRes = await fetch(`https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`);
    if (!imgRes.ok) return null;
    return Buffer.from(await imgRes.arrayBuffer());
  } catch (e) {
    return null;
  }
}

app.get("/api/health", (req, res) => res.json({ ok: true }));

function construirPrompt_(descripcion) {
  return `Estas leyendo la foto de una factura o recibo de un gasto de una empresa colombiana de construccion/ingenieria llamada JACBEL. La factura puede estar impresa o escrita a mano (manuscrita); lee con cuidado tanto letra de imprenta como letra manuscrita, incluyendo numeros escritos a mano que a veces son ambiguos (por ejemplo diferenciar 1 de 7, o 0 de 6). El usuario escribio esta descripcion del gasto: "${descripcion || "(sin descripcion)"}".

Extrae del recibo/factura estos datos y responde UNICAMENTE con un JSON valido, sin texto adicional, con esta forma exacta:
{
  "fecha": "YYYY-MM-DD",
  "comercio": "nombre del comercio o proveedor",
  "nit": "NIT o numero de identificacion tributaria del comercio o proveedor",
  "valor": 12345,
  "iva": 1234,
  "categoria": "una de estas: ${CATEGORIAS.join(", ")}",
  "descripcion": "detalle de los articulos o items comprados, tal como aparecen en la factura"
}

Reglas:
- "valor" es el total pagado en pesos colombianos (COP), como numero entero sin puntos ni comas ni simbolo de moneda.
- "iva" es el valor del IVA discriminado por separado en la factura (no el total), como numero entero en COP. Solo aparece cuando la factura lo desglosa explicitamente (por ejemplo una linea "IVA" o "IVA 19%"). Si la factura no discrimina el IVA por separado, o no es legible, deja este campo como cadena vacia "" (no lo calcules ni lo estimes tu mismo).
- "nit" debe copiarse tal como aparece impreso o escrito en la factura (con puntos y guion si los tiene, por ejemplo "900.123.456-7"). Suele estar cerca del nombre del comercio, a veces con la etiqueta "NIT" o "Nit.". Si no aparece ningun NIT legible en la foto, deja este campo como cadena vacia "".
- Si no logras leer la fecha en la foto, usa la fecha de hoy.
- Si no logras leer el comercio, usa la descripcion del usuario para inferirlo.
- "categoria" debe ser exactamente una de las opciones listadas.
- Responde SIEMPRE con el JSON completo, incluso si la imagen es dificil de leer (letra manuscrita poco clara, foto borrosa, etc). Nunca respondas con una disculpa ni texto explicando que no puedes leerla: en vez de eso, haz tu mejor estimacion razonable para cada campo, y si de verdad un campo especifico es ilegible, usa "" para textos o 0 para "valor" en ese campo unicamente (no inventes un valor que no puedas sustentar en la imagen o la descripcion).`;
}

async function leerFacturaConIA_(base64Image, mediaType, descripcion) {
  const intentos = [CLAUDE_MODEL, CLAUDE_MODEL_REINTENTO];
  let ultimoExtraido = null;

  for (let i = 0; i < intentos.length; i++) {
    try {
      const message = await anthropic.messages.create({
        model: intentos[i],
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
              { type: "text", text: construirPrompt_(descripcion) },
            ],
          },
        ],
      });
      const textBlock = message.content.find((b) => b.type === "text");
      const jsonMatch = textBlock && textBlock.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extraido = JSON.parse(jsonMatch[0]);
        ultimoExtraido = extraido;
        const valor = Number(extraido.valor) || 0;
        const comercio = (extraido.comercio || "").trim();
        // Si logro leer un valor y un comercio, damos el resultado por bueno.
        if (valor > 0 && comercio) {
          return { extraido, necesitaRevision: false };
        }
      }
    } catch (e) {
      console.error(`Fallo lectura con modelo ${intentos[i]}:`, e.message);
    }
  }

  // Ningun intento produjo un resultado completo: devolvemos lo mejor que se
  // haya logrado extraer (puede tener campos vacios) y marcamos para revision manual.
  return { extraido: ultimoExtraido, necesitaRevision: true };
}

app.post("/api/gastos", upload.single("foto"), async (req, res) => {
  try {
    requireAppsScriptUrl();
    const descripcion = (req.body.descripcion || "").trim();
    const obra = (req.body.obra || "").trim();
    const trabajador = (req.body.trabajador || "").trim();
    if (!req.file) {
      return res.status(400).json({ error: "Falta la foto de la factura" });
    }

    const base64Image = req.file.buffer.toString("base64");
    const mediaType = req.file.mimetype || "image/jpeg";

    const { extraido, necesitaRevision } = await leerFacturaConIA_(base64Image, mediaType, descripcion);

    const fechaExtraida = (extraido && extraido.fecha) || "";
    const hoyStr = new Date().toISOString().slice(0, 10);
    let fecha = fechaExtraida || hoyStr;
    let motivoRevision = "";
    if (fechaExtraida && fechaExtraida < FECHA_MINIMA_FACTURAS) {
      motivoRevision = `La fecha que leyó la IA en la factura (${fechaExtraida}) es anterior a julio de 2026, así que probablemente la lectura fue incorrecta. Verifica y completa la fecha manualmente.`;
      fecha = "";
    } else if (fechaExtraida && fechaExtraida > hoyStr) {
      motivoRevision = `La fecha que leyó la IA en la factura (${fechaExtraida}) es posterior a hoy, así que probablemente la lectura fue incorrecta. Verifica y completa la fecha manualmente.`;
      fecha = "";
    }

    const comercio = (extraido && extraido.comercio) || "";
    const nit = (extraido && extraido.nit) || "";
    const valor = Number(extraido && extraido.valor) || 0;
    const iva = Number(extraido && extraido.iva) || "";
    const categoria = extraido && CATEGORIAS.includes(extraido.categoria) ? extraido.categoria : "Otros";
    const detalleIA = (extraido && extraido.descripcion) || "";
    const descripcionFinal = [descripcion, detalleIA].filter(Boolean).join(" — ");
    const necesitaRevisionFinal = necesitaRevision || !!motivoRevision;
    const estado = necesitaRevisionFinal ? "No se pudo leer - completar a mano" : "Pendiente revision";

    const extension = mediaType.includes("png") ? "png" : "jpg";
    const fechaParaArchivo = fecha || hoyStr;
    const fotoNombre = `${fechaParaArchivo}_${(comercio || "gasto").replace(/[^a-zA-Z0-9._-]+/g, "_")}.${extension}`;

    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fecha, descripcion: descripcionFinal, comercio, categoria, valor, iva, obra, nit, estado, trabajador,
        fotoBase64: base64Image, fotoMimeType: mediaType, fotoNombre,
      }),
    });
    const scriptData = await scriptRes.json();
    if (!scriptData.ok) {
      return res.status(502).json({ error: scriptData.error || "Error al guardar en Google Sheets" });
    }

    res.json({ ...scriptData, necesitaRevision: necesitaRevisionFinal, motivoRevision });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

function construirUrlFiltrada_(baseUrl, query) {
  const { desde, hasta, obra, trabajador } = query;
  const params = new URLSearchParams();
  if (desde) params.set("desde", desde);
  if (hasta) params.set("hasta", hasta);
  if (obra) params.set("obra", obra);
  if (trabajador) params.set("trabajador", trabajador);
  const qs = params.toString();
  return qs ? `${baseUrl}?${qs}` : baseUrl;
}

app.get("/api/gastos", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const url = construirUrlFiltrada_(APPS_SCRIPT_URL, req.query);
    const scriptRes = await fetch(url);
    const gastos = await scriptRes.json();
    res.json(gastos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.get("/api/obras", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const scriptRes = await fetch(`${APPS_SCRIPT_URL}?obras=1`);
    const obras = await scriptRes.json();
    res.json(obras);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.get("/api/trabajadores", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const scriptRes = await fetch(`${APPS_SCRIPT_URL}?trabajadores=1`);
    const trabajadores = await scriptRes.json();
    res.json(trabajadores);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.post("/api/trabajadores", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { nombre } = req.body;
    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accion: "crear_trabajador", nombre }),
    });
    const data = await scriptRes.json();
    if (!data.ok) return res.status(400).json({ error: data.error || "Error al agregar el trabajador" });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.post("/api/caja-menor", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { trabajador, fecha, valor } = req.body;
    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accion: "crear_caja_menor", trabajador, fecha, valor }),
    });
    const data = await scriptRes.json();
    if (!data.ok) return res.status(400).json({ error: data.error || "Error al crear la caja menor" });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.get("/api/caja-menor/:id/pdf", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const cajaId = req.params.id;
    const scriptRes = await fetch(`${APPS_SCRIPT_URL}?cajaMenorId=${encodeURIComponent(cajaId)}`);
    const data = await scriptRes.json();
    if (!data.caja) {
      return res.status(404).json({ error: "No se encontro la caja menor" });
    }

    const { caja, gastos } = data;
    const consumido = gastos.reduce((s, g) => s + (Number(g.valor) || 0), 0);
    const deudaArrastrada = Number(caja.deudaArrastrada) || 0;
    const restante = (Number(caja.valorEntregado) || 0) - deudaArrastrada - consumido;
    const nombreArchivo = `caja-menor-${(caja.trabajador || "trabajador").replace(/[^a-zA-Z0-9._-]+/g, "_")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nombreArchivo}"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    if (LOGO_BUFFER) {
      const logoWidth = 90;
      doc.image(LOGO_BUFFER, doc.page.margins.left, doc.page.margins.top, { fit: [logoWidth, logoWidth] });
      doc.y = doc.page.margins.top + logoWidth + 10;
      doc.x = doc.page.margins.left;
    }

    doc.fontSize(18).fillColor("#1F4E78").text("Reporte de caja menor", { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor("#000000");
    doc.text(`Trabajador: ${caja.trabajador || ""}`);
    doc.text(`Fecha de entrega: ${(caja.fecha || "").toString().slice(0, 10)}`);
    doc.text(`Valor entregado: ${fmtCOP_(caja.valorEntregado)}`);
    if (deudaArrastrada > 0) {
      doc.text(`Deuda arrastrada de la caja anterior: ${fmtCOP_(deudaArrastrada)}`);
    }
    doc.text(`Total gastado: ${fmtCOP_(consumido)}`);
    doc.fillColor(restante < 0 ? "#C0392B" : "#2E7D32");
    doc.text(restante < 0
      ? `Le deben al trabajador: ${fmtCOP_(-restante)}`
      : `Saldo a favor de la empresa: ${fmtCOP_(restante)}`);
    doc.fillColor("#000000");
    doc.moveDown();

    doc.fontSize(13).text("Gastos cargados a esta caja menor", { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10);
    if (!gastos.length) {
      doc.text("No hay gastos cargados a esta caja menor todavia.");
    }
    gastos.forEach((g, i) => {
      doc.text(`${i + 1}. ${(g.fecha || "").toString().slice(0, 10)} - ${g.comercio || "Sin nombre"}${g.nit ? " (NIT " + g.nit + ")" : ""}`);
      if (g.descripcion) doc.text(`   ${g.descripcion}`);
      doc.text(`   Valor: ${fmtCOP_(g.valor)}`);
      doc.moveDown(0.2);
    });

    for (const g of gastos) {
      if (!g.fotoUrl) continue;
      const buffer = await descargarImagenDrive_(g.fotoUrl);
      if (!buffer) continue;
      doc.addPage();
      doc.fontSize(11).fillColor("#000000").text(`Anexo: ${(g.fecha || "").toString().slice(0, 10)} - ${g.comercio || ""}`);
      doc.moveDown(0.3);
      doc.image(buffer, { fit: [500, 650], align: "center" });
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

// ---------- Informe ejecutivo de gastos (PDF) ----------

const INFORME_COLOR_TEXTO = "#1D1D1F";
const INFORME_COLOR_MUTED = "#6E6E73";
const INFORME_COLOR_TARJETA = "#F5F5F7";
const INFORME_COLOR_ACENTO = "#E8541E";
const INFORME_COLOR_CARBON = "#2B2B2B";

function construirSubtituloInforme_(query) {
  const partes = [];
  if (query.obra) partes.push(`Obra: ${query.obra.split(",").join(", ")}`);
  if (query.trabajador) {
    const nombres = query.trabajador.split(",").map((t) => (t === "__sin_caja__" ? "Sin caja menor" : t));
    partes.push(`Caja menor: ${nombres.join(", ")}`);
  }
  if (query.desde && query.hasta) {
    partes.push(`Del ${fmtFechaCorta_(query.desde)} al ${fmtFechaCorta_(query.hasta)}`);
  }
  return partes.length ? partes.join(" · ") : "Todos los gastos registrados";
}

function dibujarTarjetaMetrica_(doc, x, y, w, h, etiqueta, valor) {
  doc.roundedRect(x, y, w, h, 12).fill(INFORME_COLOR_TARJETA);
  doc.fillColor(INFORME_COLOR_ACENTO).fontSize(18).font("Helvetica-Bold")
    .text(valor, x + 14, y + 14, { width: w - 28 });
  doc.fillColor(INFORME_COLOR_MUTED).fontSize(9).font("Helvetica")
    .text(etiqueta, x + 14, y + h - 26, { width: w - 28 });
}

app.get("/api/informe-pdf", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const url = construirUrlFiltrada_(APPS_SCRIPT_URL, req.query);
    const scriptRes = await fetch(url);
    const gastos = await scriptRes.json();
    if (!Array.isArray(gastos)) {
      return res.status(502).json({ error: "No se pudo obtener la lista de gastos" });
    }

    const totalGastado = gastos.reduce((s, g) => s + (Number(g.valor) || 0), 0);
    const cantidadGastos = gastos.length;
    const promedio = cantidadGastos ? totalGastado / cantidadGastos : 0;
    const gastosConIva = gastos.filter((g) => Number(g.iva) > 0);
    const totalIva = gastosConIva.reduce((s, g) => s + Number(g.iva), 0);
    const sinIvaCount = cantidadGastos - gastosConIva.length;

    const subtitulo = construirSubtituloInforme_(req.query);
    const sufijoArchivo = req.query.desde && req.query.hasta
      ? `${req.query.desde}-a-${req.query.hasta}`
      : new Date().toISOString().slice(0, 10);
    const nombreArchivo = `informe-gastos-jacbel-${sufijoArchivo}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nombreArchivo}"`);

    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.pipe(res);
    const left = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;

    // ---- Encabezado ----
    let headerTop = doc.y;
    if (LOGO_BUFFER) {
      doc.image(LOGO_BUFFER, left, headerTop, { fit: [56, 56] });
    }
    const textoX = LOGO_BUFFER ? left + 68 : left;
    doc.fillColor(INFORME_COLOR_TEXTO).fontSize(20).font("Helvetica-Bold")
      .text("Informe Ejecutivo de Gastos", textoX, headerTop + 2, { width: usableWidth - (textoX - left) });
    doc.fillColor(INFORME_COLOR_MUTED).fontSize(10).font("Helvetica")
      .text(subtitulo, textoX, doc.y, { width: usableWidth - (textoX - left) });
    doc.y = Math.max(doc.y, headerTop + 56) + 20;

    // ---- Tarjetas de metricas (2x2) ----
    const gap = 12;
    const cardW = (usableWidth - gap) / 2;
    const cardH = 68;
    const cardsTop = doc.y;
    dibujarTarjetaMetrica_(doc, left, cardsTop, cardW, cardH, "Total gastado", fmtCOP_(totalGastado));
    dibujarTarjetaMetrica_(doc, left + cardW + gap, cardsTop, cardW, cardH, "Cantidad de gastos", String(cantidadGastos));
    dibujarTarjetaMetrica_(doc, left, cardsTop + cardH + gap, cardW, cardH, "Promedio por gasto", fmtCOP_(promedio));
    dibujarTarjetaMetrica_(doc, left + cardW + gap, cardsTop + cardH + gap, cardW, cardH, "IVA recuperable", fmtCOP_(totalIva));
    doc.y = cardsTop + cardH * 2 + gap + 18;
    doc.x = left;
    if (sinIvaCount > 0) {
      doc.fillColor(INFORME_COLOR_MUTED).fontSize(8).font("Helvetica")
        .text(`IVA recuperable calculado sobre ${gastosConIva.length} de ${cantidadGastos} gastos (los demas no tienen IVA discriminado registrado).`,
          left, doc.y, { width: usableWidth });
      doc.moveDown(0.8);
    }

    // ---- Tabla resumen ----
    const columnas = [
      { titulo: "Fecha", width: 55 },
      { titulo: "Proveedor", width: 150 },
      { titulo: "Categoria", width: 90 },
      { titulo: "Estado", width: 130 },
      { titulo: "Monto", width: 90, align: "right" },
    ];
    const rowH = 20;

    function dibujarEncabezadoTabla_() {
      const y = doc.y;
      doc.rect(left, y, usableWidth, rowH).fill(INFORME_COLOR_CARBON);
      let x = left;
      doc.fontSize(9).font("Helvetica-Bold").fillColor("#FFFFFF");
      columnas.forEach((c) => {
        doc.text(c.titulo, x + 6, y + 6, { width: c.width - 10, align: c.align || "left" });
        x += c.width;
      });
      doc.y = y + rowH;
      doc.x = left;
    }

    doc.fontSize(13).font("Helvetica-Bold").fillColor(INFORME_COLOR_TEXTO)
      .text("Resumen de gastos", left, doc.y, { width: usableWidth });
    doc.moveDown(0.4);
    dibujarEncabezadoTabla_();

    if (!gastos.length) {
      doc.fontSize(10).font("Helvetica").fillColor(INFORME_COLOR_MUTED)
        .text("No hay gastos que coincidan con los filtros aplicados.", left, doc.y + 8, { width: usableWidth });
    }

    gastos.forEach((g, i) => {
      if (doc.y + rowH > bottomLimit) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        dibujarEncabezadoTabla_();
      }
      const y = doc.y;
      if (i % 2 === 1) doc.rect(left, y, usableWidth, rowH).fill(INFORME_COLOR_TARJETA);
      let x = left;
      doc.fontSize(8.5).font("Helvetica").fillColor(INFORME_COLOR_TEXTO);
      const celdas = [
        fmtFechaCorta_(g.fecha),
        g.comercio || "Sin nombre",
        g.categoria || "Otros",
        g.estado || "Registrado",
        fmtCOP_(g.valor),
      ];
      columnas.forEach((c, ci) => {
        doc.text(celdas[ci], x + 6, y + 6, { width: c.width - 10, align: c.align || "left", ellipsis: true });
        x += c.width;
      });
      doc.y = y + rowH;
      doc.x = left;
    });

    // ---- Anexo de facturas ----
    const gastosConFoto = gastos.filter((g) => g.fotoUrl);
    const imagenes = await Promise.all(gastosConFoto.map((g) => descargarImagenDrive_(g.fotoUrl)));
    gastosConFoto.forEach((g, i) => {
      const buffer = imagenes[i];
      if (!buffer) return;
      doc.addPage();
      doc.fillColor(INFORME_COLOR_TEXTO).fontSize(11).font("Helvetica-Bold")
        .text(`Anexo: ${fmtFechaCorta_(g.fecha)} — ${g.comercio || "Sin nombre"} — ${fmtCOP_(g.valor)}`,
          left, doc.page.margins.top, { width: usableWidth });
      doc.moveDown(0.5);
      doc.image(buffer, { fit: [usableWidth, 650], align: "center" });
    });

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.put("/api/gastos/:id", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { fecha, descripcion, comercio, categoria, valor, iva, obra, nit, trabajador } = req.body;
    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accion: "editar", id: req.params.id,
        fecha, descripcion, comercio, categoria, valor: Number(valor) || 0,
        iva: Number(iva) || "", obra, nit,
        trabajador: trabajador || "",
        estado: "Registrado",
      }),
    });
    const scriptData = await scriptRes.json();
    if (!scriptData.ok) {
      return res.status(502).json({ error: scriptData.error || "Error al editar el gasto" });
    }
    res.json(scriptData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.delete("/api/gastos/:id", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accion: "eliminar", id: req.params.id }),
    });
    const scriptData = await scriptRes.json();
    if (!scriptData.ok) {
      return res.status(502).json({ error: scriptData.error || "Error al eliminar el gasto" });
    }
    res.json(scriptData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.listen(PORT, () => console.log(`Gastos JACBEL escuchando en puerto ${PORT}`));
