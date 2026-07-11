require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");

const PORT = process.env.PORT || 3000;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

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

app.post("/api/gastos", upload.single("foto"), async (req, res) => {
  try {
    requireAppsScriptUrl();
    const descripcion = (req.body.descripcion || "").trim();
    const obra = (req.body.obra || "").trim();
    if (!req.file) {
      return res.status(400).json({ error: "Falta la foto de la factura" });
    }

    const base64Image = req.file.buffer.toString("base64");
    const mediaType = req.file.mimetype || "image/jpeg";

    const prompt = `Estas leyendo la foto de una factura o recibo de un gasto de una empresa colombiana de construccion/ingenieria llamada JACBEL. El usuario escribio esta descripcion del gasto: "${descripcion || "(sin descripcion)"}".

Extrae del recibo/factura estos datos y responde UNICAMENTE con un JSON valido, sin texto adicional, con esta forma exacta:
{
  "fecha": "YYYY-MM-DD",
  "comercio": "nombre del comercio o proveedor",
  "valor": 12345,
  "categoria": "una de estas: ${CATEGORIAS.join(", ")}",
  "notas": "detalle breve opcional, por ejemplo items comprados"
}

Reglas:
- "valor" es el total pagado en pesos colombianos (COP), como numero entero sin puntos ni comas ni simbolo de moneda.
- Si no logras leer la fecha en la foto, usa la fecha de hoy.
- Si no logras leer el comercio, usa la descripcion del usuario para inferirlo.
- "categoria" debe ser exactamente una de las opciones listadas.
- No inventes datos que no puedas sustentar en la imagen o la descripcion; si algo no es legible, haz tu mejor estimacion razonable.`;

    const message = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64Image } },
            { type: "text", text: prompt },
          ],
        },
      ],
    });

    const textBlock = message.content.find((b) => b.type === "text");
    let extraido;
    try {
      const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
      extraido = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(502).json({ error: "No se pudo interpretar la respuesta de la IA", raw: textBlock?.text });
    }

    const fecha = extraido.fecha || new Date().toISOString().slice(0, 10);
    const comercio = extraido.comercio || "";
    const valor = Number(extraido.valor) || 0;
    const categoria = CATEGORIAS.includes(extraido.categoria) ? extraido.categoria : "Otros";
    const notas = extraido.notas || "";

    const extension = mediaType.includes("png") ? "png" : "jpg";
    const fotoNombre = `${fecha}_${(comercio || "gasto").replace(/[^a-zA-Z0-9._-]+/g, "_")}.${extension}`;

    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fecha, descripcion, comercio, categoria, valor, notas, obra,
        fotoBase64: base64Image, fotoMimeType: mediaType, fotoNombre,
      }),
    });
    const scriptData = await scriptRes.json();
    if (!scriptData.ok) {
      return res.status(502).json({ error: scriptData.error || "Error al guardar en Google Sheets" });
    }

    res.json(scriptData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Error inesperado" });
  }
});

app.get("/api/gastos", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const scriptRes = await fetch(APPS_SCRIPT_URL);
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

app.put("/api/gastos/:id", async (req, res) => {
  try {
    requireAppsScriptUrl();
    const { fecha, descripcion, comercio, categoria, valor, notas, obra } = req.body;
    const scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accion: "editar", id: req.params.id,
        fecha, descripcion, comercio, categoria, valor: Number(valor) || 0, notas, obra,
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
