// ID de la carpeta de Drive donde se guardan las fotos de las facturas.
var FOLDER_ID = "1D8FpmwzMobg4z6_6tYFuaPEqSAWYy730";

// Columnas de la hoja "Gastos" (primera hoja): A Fecha, B Descripcion, C Comercio,
// D Categoria, E Valor, F Estado, G (sin uso, antes Notas), H Foto, I Foto URL, J Registrado,
// K Obra, L ID, M NIT, N Trabajador (caja menor), O CajaMenorId

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.accion === "editar") {
      return editarGasto_(body);
    }
    if (body.accion === "crear_trabajador") {
      return crearTrabajador_(body);
    }
    if (body.accion === "crear_caja_menor") {
      return crearCajaMenor_(body);
    }
    return crearGasto_(body);
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  }
}

function crearGasto_(body) {
  var fecha = body.fecha;
  var descripcion = body.descripcion || "";
  var comercio = body.comercio || "";
  var categoria = body.categoria || "";
  var valor = body.valor || 0;
  var notas = "";
  var obra = body.obra || "";
  var nit = body.nit || "";
  var estado = body.estado || "Pendiente revision";
  var trabajador = body.trabajador || "";

  var folder = DriveApp.getFolderById(FOLDER_ID);
  var decoded = Utilities.base64Decode(body.fotoBase64);
  var blob = Utilities.newBlob(decoded, body.fotoMimeType, body.fotoNombre);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();
  var thumbnailUrl = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w800";
  var viewUrl = "https://drive.google.com/file/d/" + fileId + "/view";
  var id = Utilities.getUuid();

  var cajaMenorId = "";
  if (trabajador) {
    var caja = cajaActivaDeTrabajador_(trabajador);
    if (caja) cajaMenorId = caja.id;
  }

  var sheet = hojaGastos_();
  sheet.appendRow([
    fecha, descripcion, comercio, categoria, valor, estado, notas,
    '=IMAGE("' + thumbnailUrl + '")', viewUrl, new Date().toISOString(), obra, id, nit,
    trabajador, cajaMenorId,
  ]);

  return jsonOutput_({
    ok: true, id: id, fecha: fecha, descripcion: descripcion, comercio: comercio,
    categoria: categoria, valor: valor, obra: obra, nit: nit, fotoUrl: viewUrl,
    estado: estado, trabajador: trabajador,
  });
}

function editarGasto_(body) {
  var sheet = hojaGastos_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonOutput_({ ok: false, error: "No hay gastos registrados" });

  var ids = sheet.getRange(2, 12, lastRow - 1, 1).getValues();
  var rowIndex = -1;
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === body.id) { rowIndex = i + 2; break; }
  }
  if (rowIndex === -1) return jsonOutput_({ ok: false, error: "No se encontro el gasto a editar" });

  sheet.getRange(rowIndex, 1).setValue(body.fecha || "");
  sheet.getRange(rowIndex, 2).setValue(body.descripcion || "");
  sheet.getRange(rowIndex, 3).setValue(body.comercio || "");
  sheet.getRange(rowIndex, 4).setValue(body.categoria || "");
  sheet.getRange(rowIndex, 5).setValue(body.valor || 0);
  if (body.estado) sheet.getRange(rowIndex, 6).setValue(body.estado);
  sheet.getRange(rowIndex, 11).setValue(body.obra || "");
  sheet.getRange(rowIndex, 13).setValue(body.nit || "");

  var trabajador = body.trabajador || "";
  var cajaMenorId = "";
  if (trabajador) {
    var caja = cajaActivaDeTrabajador_(trabajador);
    if (caja) cajaMenorId = caja.id;
  }
  sheet.getRange(rowIndex, 14).setValue(trabajador);
  sheet.getRange(rowIndex, 15).setValue(cajaMenorId);

  return jsonOutput_({ ok: true, id: body.id });
}
function doGet(e) {
  try {
    if (e.parameter.obras === "1") {
      return jsonOutput_(obtenerObras_());
    }
    if (e.parameter.trabajadores === "1") {
      return jsonOutput_(obtenerTrabajadoresConCajas_());
    }
    if (e.parameter.cajaMenorId) {
      return jsonOutput_({
        caja: obtenerCajaPorId_(e.parameter.cajaMenorId),
        gastos: obtenerGastosDeCaja_(e.parameter.cajaMenorId),
      });
    }
    if (e.parameter.mes && e.parameter.anio) {
      var mes = parseInt(e.parameter.mes, 10);
      var anio = parseInt(e.parameter.anio, 10);
      return jsonOutput_(obtenerGastosPorMes_(mes, anio));
    }
    var sheet = hojaGastos_();
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonOutput_([]);
    var numRows = Math.min(30, lastRow - 1);
    var startRow = lastRow - numRows + 1;
    var values = sheet.getRange(startRow, 1, numRows, 15).getValues();
    var gastos = values.map(filaAGasto_).reverse();
    return jsonOutput_(gastos);
  } catch (err) {
    return jsonOutput_({ error: String(err) });
  }
}

function obtenerGastosPorMes_(mes, anio) {
  var sheet = hojaGastos_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 15).getValues();
  var gastos = [];
  values.forEach(function (r) {
    var partes = obtenerAnioMes_(r[0]);
    if (partes && partes.mes === mes && partes.anio === anio) {
      gastos.push(filaAGasto_(r));
    }
  });
  gastos.reverse();
  return gastos;
}

function obtenerAnioMes_(fecha) {
  if (fecha === null || fecha === undefined || fecha === "") return null;
  var texto;
  if (typeof fecha === "object" && typeof fecha.getFullYear === "function") {
    texto = Utilities.formatDate(fecha, Session.getScriptTimeZone(), "yyyy-MM-dd");
  } else {
    texto = String(fecha);
  }
  var m = texto.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { anio: parseInt(m[1], 10), mes: parseInt(m[2], 10) };
  return null;
}

function filaAGasto_(r) {
  return {
    fecha: r[0], descripcion: r[1], comercio: r[2], categoria: r[3],
    valor: r[4], estado: r[5], fotoUrl: r[8], obra: r[10], id: r[11],
    nit: r[12], trabajador: r[13] || "", cajaMenorId: r[14] || "",
  };
}

function obtenerObras_() {
  var sheet = hojaGastos_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 11, lastRow - 1, 1).getValues();
  var vistos = {};
  var lista = [];
  values.forEach(function (r) {
    var obra = r[0];
    if (obra && !vistos[obra]) { vistos[obra] = true; lista.push(obra); }
  });
  lista.sort();
  return lista;
}
// ---------- Caja menor ----------

function crearTrabajador_(body) {
  var nombre = (body.nombre || "").trim();
  if (!nombre) return jsonOutput_({ ok: false, error: "Falta el nombre" });
  var sheet = hojaTrabajadores_();
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var nombres = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
    for (var i = 0; i < nombres.length; i++) {
      if (nombres[i][0] === nombre) {
        sheet.getRange(i + 2, 2).setValue(true);
        return jsonOutput_({ ok: true });
      }
    }
  }
  sheet.appendRow([nombre, true]);
  return jsonOutput_({ ok: true });
}

function crearCajaMenor_(body) {
  var trabajador = (body.trabajador || "").trim();
  var fecha = body.fecha || "";
  var valor = Number(body.valor) || 0;
  if (!trabajador) return jsonOutput_({ ok: false, error: "Falta el trabajador" });
  if (!fecha) return jsonOutput_({ ok: false, error: "Falta la fecha" });
  if (!valor || valor <= 0) return jsonOutput_({ ok: false, error: "El valor debe ser mayor a 0" });

  // Cierra cualquier caja activa anterior de este trabajador; la nueva la reemplaza.
  // Si esa caja anterior quedo con saldo negativo (se gasto mas de lo entregado),
  // esa deuda se arrastra y se descuenta del saldo de la nueva caja.
  var sheet = hojaCajasMenores_();
  var lastRow = sheet.getLastRow();
  var deudaArrastrada = 0;
  if (lastRow >= 2) {
    var filas = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    for (var i = 0; i < filas.length; i++) {
      if (filas[i][1] === trabajador && filas[i][4] === true) {
        var cajaAnteriorId = filas[i][0];
        var valorAnterior = Number(filas[i][3]) || 0;
        var deudaPrevia = Number(filas[i][5]) || 0;
        var consumidoAnterior = consumidoDeCaja_(cajaAnteriorId);
        var restanteAnterior = valorAnterior - deudaPrevia - consumidoAnterior;
        if (restanteAnterior < 0) deudaArrastrada = -restanteAnterior;
        sheet.getRange(i + 2, 5).setValue(false);
      }
    }
  }

  var id = Utilities.getUuid();
  sheet.appendRow([id, trabajador, fecha, valor, true, deudaArrastrada]);
  return jsonOutput_({ ok: true, id: id, deudaArrastrada: deudaArrastrada });
}

function cajaActivaDeTrabajador_(trabajador) {
  var sheet = hojaCajasMenores_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var filas = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  for (var i = 0; i < filas.length; i++) {
    if (filas[i][1] === trabajador && filas[i][4] === true) {
      return { id: filas[i][0], trabajador: filas[i][1], fecha: filas[i][2], valor: filas[i][3] };
    }
  }
  return null;
}

function consumidoDeCaja_(cajaId) {
  var sheet = hojaGastos_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var valores = sheet.getRange(2, 5, lastRow - 1, 1).getValues();
  var cajaIds = sheet.getRange(2, 15, lastRow - 1, 1).getValues();
  var total = 0;
  for (var i = 0; i < cajaIds.length; i++) {
    if (cajaIds[i][0] === cajaId) total += Number(valores[i][0]) || 0;
  }
  return total;
}
function obtenerCajaPorId_(cajaId) {
  var sheet = hojaCajasMenores_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var filas = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  for (var i = 0; i < filas.length; i++) {
    if (filas[i][0] === cajaId) {
      return {
        id: filas[i][0], trabajador: filas[i][1], fecha: filas[i][2],
        valorEntregado: filas[i][3], activa: filas[i][4] === true,
        deudaArrastrada: Number(filas[i][5]) || 0,
      };
    }
  }
  return null;
}

function obtenerGastosDeCaja_(cajaId) {
  var sheet = hojaGastos_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 15).getValues();
  var gastos = [];
  values.forEach(function (r) {
    if (r[14] === cajaId) gastos.push(filaAGasto_(r));
  });
  gastos.sort(function (a, b) { return a.fecha < b.fecha ? -1 : 1; });
  return gastos;
}

function obtenerTrabajadoresConCajas_() {
  var sheetTrab = hojaTrabajadores_();
  var lastRow = sheetTrab.getLastRow();
  var activos = [];
  if (lastRow >= 2) {
    var filas = sheetTrab.getRange(2, 1, lastRow - 1, 2).getValues();
    filas.forEach(function (r) {
      if (r[1] === true) activos.push(r[0]);
    });
  }

  var sheetCajas = hojaCajasMenores_();
  var lastRowCajas = sheetCajas.getLastRow();
  var todasLasCajas = [];
  if (lastRowCajas >= 2) {
    todasLasCajas = sheetCajas.getRange(2, 1, lastRowCajas - 1, 6).getValues();
  }

  return activos.map(function (nombre) {
    var cajasDelTrabajador = todasLasCajas
      .filter(function (r) { return r[1] === nombre; })
      .map(function (r) {
        var deudaArrastrada = Number(r[5]) || 0;
        var consumido = consumidoDeCaja_(r[0]);
        return {
          id: r[0], fecha: r[2], valorEntregado: r[3], activa: r[4] === true,
          deudaArrastrada: deudaArrastrada, consumido: consumido,
          restante: r[3] - deudaArrastrada - consumido,
        };
      })
      .sort(function (a, b) { return a.fecha < b.fecha ? 1 : -1; });
    var cajaActiva = cajasDelTrabajador.find(function (c) { return c.activa; }) || null;
    return { nombre: nombre, cajaActiva: cajaActiva, historial: cajasDelTrabajador };
  });
}
// ---------- Utilidades de hojas ----------

function hojaGastos_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
}

function obtenerOCrearHoja_(nombre, encabezados) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(nombre);
  if (!sheet) {
    sheet = ss.insertSheet(nombre);
    sheet.appendRow(encabezados);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function hojaTrabajadores_() {
  return obtenerOCrearHoja_("Trabajadores", ["Nombre", "Activo"]);
}

function hojaCajasMenores_() {
  var sheet = obtenerOCrearHoja_("CajasMenores", ["Id", "Trabajador", "FechaEntrega", "ValorEntregado", "Activa", "DeudaArrastrada"]);
  if (sheet.getLastColumn() < 6) {
    sheet.getRange(1, 6).setValue("DeudaArrastrada");
  }
  return sheet;
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
