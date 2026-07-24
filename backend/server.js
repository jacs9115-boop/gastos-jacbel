require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(require("path").join(__dirname, "..", "frontend")));

const upload = multer({ limits: { fileSize: 12 * 1024 * 1024 } });

function requireAppsScriptUrl() {
  if (!APPS_SCRIPT_URL) throw new Error("Falta APPS_SCRIPT_URL");
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
  "categoria": "una de estas: ${CATEGORIAS.join(", ")}",
  "notas": "detalle breve opcional, por ejemplo items comprados"
}

Reglas:
- "valor" es el total pagado en pesos colombianos (COP), como numero entero sin puntos ni comas ni simbolo de moneda.
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

    const fecha = (extraido && extraido.fecha) || new Date().toISOString().slice(0, 10);
    const comercio = (extraido && extraido.comercio) || "";
    const nit = (extraido && extraido.nit) || "";
    const valor = Number(extraido && extraido.valor) || 0;
    const categoria = extraido && CATEGORIAS.includes(extraido.categoria) ? extraido.categoria : "Otros";
    const notas = (extraido && extraido.notas) || "";
    const estado = necesitaRevision ? "No se pudo leer - completar a mano" : "Pendiente revision";

    const extension = mediaType.includes("png") ? "png" : "jpg";
    const fotoNombre = `${fecha}_${(comercio || "gasto").replace(/[^a-zA-Z0-9._-]+/g, "_")}.${extension}`;

    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fecha, descripcion, comercio, categoria, valor, notas, obra, nit, estado, trabajador,
        fotoBase64: base64Image, fotoMimeType: mediaType, fotoNombre,
      }),
    });
    const scriptData = await scriptRes.json();
    if (!scriptData.ok) {
      return res.status(502).json({ error: scriptData.error || "Error al guardar en Google Sheets" });
    }

    res.json({ ...scriptData, necesitaRevision });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});
app.get("/api/gastos", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { mes, anio } = req.query;
    let url = APPS_SCRIPT_URL;
    if (mes && anio) {
      url += `?mes=${encodeURIComponent(mes)}&anio=${encodeURIComponent(anio)}`;
    }
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
    const fmt = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-CO");
    const nombreArchivo = `caja-menor-${(caja.trabajador || "trabajador").replace(/[^a-zA-Z0-9._-]+/g, "_")}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nombreArchivo}"`);

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(res);

    doc.fontSize(18).fillColor("#1F4E78").text("Reporte de caja menor", { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor("#000000");
    doc.text(`Trabajador: ${caja.trabajador || ""}`);
    doc.text(`Fecha de entrega: ${(caja.fecha || "").toString().slice(0, 10)}`);
    doc.text(`Valor entregado: ${fmt(caja.valorEntregado)}`);
    if (deudaArrastrada > 0) {
      doc.text(`Deuda arrastrada de la caja anterior: ${fmt(deudaArrastrada)}`);
    }
    doc.text(`Total gastado: ${fmt(consumido)}`);
    doc.fillColor(restante < 0 ? "#C0392B" : "#2E7D32");
    doc.text(restante < 0
      ? `Le deben al trabajador: ${fmt(-restante)}`
      : `Saldo a favor de la empresa: ${fmt(restante)}`);
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
      doc.text(`   Valor: ${fmt(g.valor)}`);
      doc.moveDown(0.2);
    });

    for (const g of gastos) {
      if (!g.fotoUrl) continue;
      const m = g.fotoUrl.match(/\/d\/([^/]+)\//);
      if (!m) continue;
      try {
        const imgRes = await fetch(`https://drive.google.com/thumbnail?id=${m[1]}&sz=w1000`);
        if (!imgRes.ok) continue;
        const buffer = Buffer.from(await imgRes.arrayBuffer());
        doc.addPage();
        doc.fontSize(11).fillColor("#000000").text(`Anexo: ${(g.fecha || "").toString().slice(0, 10)} - ${g.comercio || ""}`);
        doc.moveDown(0.3);
        doc.image(buffer, { fit: [500, 650], align: "center" });
      } catch (e) {
        // si una factura no se puede descargar, se omite y se sigue con las demas
      }
    }

    doc.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});
app.put("/api/gastos/:id", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { fecha, descripcion, comercio, categoria, valor, notas, obra, nit, trabajador } = req.body;
    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accion: "editar", id: req.params.id,
        fecha, descripcion, comercio, categoria, valor: Number(valor) || 0, notas, obra, nit,
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

app.listen(PORT, () => console.log(`Gastos JACBEL escuchando en puerto ${PORT}`));
