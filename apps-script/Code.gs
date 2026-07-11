// ID de la carpeta de Drive donde se guardan las fotos de las facturas.
var FOLDER_ID = "1D8FpmwzMobg4z6_6tYFuaPEqSAWYy730";

// Columnas de la hoja: A Fecha, B Descripcion, C Comercio, D Categoria, E Valor,
// F Estado, G Notas, H Foto, I Foto URL, J Registrado, K Obra, L ID, M NIT

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.accion === "editar") {
      return editarGasto_(body);
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
  var notas = body.notas || "";
  var obra = body.obra || "";
  var nit = body.nit || "";

  var folder = DriveApp.getFolderById(FOLDER_ID);
  var decoded = Utilities.base64Decode(body.fotoBase64);
  var blob = Utilities.newBlob(decoded, body.fotoMimeType, body.fotoNombre);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fileId = file.getId();
  var thumbnailUrl = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w800";
  var viewUrl = "https://drive.google.com/file/d/" + fileId + "/view";
  var id = Utilities.getUuid();

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet.appendRow([
    fecha, descripcion, comercio, categoria, valor, "Pendiente revision", notas,
    '=IMAGE("' + thumbnailUrl + '")', viewUrl, new Date().toISOString(), obra, id, nit,
  ]);

  return jsonOutput_({
    ok: true, id: id, fecha: fecha, descripcion: descripcion, comercio: comercio,
    categoria: categoria, valor: valor, notas: notas, obra: obra, nit: nit, fotoUrl: viewUrl,
  });
}

function editarGasto_(body) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
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
  sheet.getRange(rowIndex, 7).setValue(body.notas || "");
  sheet.getRange(rowIndex, 11).setValue(body.obra || "");
  sheet.getRange(rowIndex, 13).setValue(body.nit || "");

  return jsonOutput_({ ok: true, id: body.id });
}

function doGet(e) {
  try {
    if (e.parameter.obras === "1") {
      return jsonOutput_(obtenerObras_());
    }
    if (e.parameter.mes && e.parameter.anio) {
      var mes = parseInt(e.parameter.mes, 10);
      var anio = parseInt(e.parameter.anio, 10);
      return jsonOutput_(obtenerGastosPorMes_(mes, anio));
    }
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonOutput_([]);
    var numRows = Math.min(30, lastRow - 1);
    var startRow = lastRow - numRows + 1;
    var values = sheet.getRange(startRow, 1, numRows, 13).getValues();
    var gastos = values.map(filaAGasto_).reverse();
    return jsonOutput_(gastos);
  } catch (err) {
    return jsonOutput_({ error: String(err) });
  }
}

function obtenerGastosPorMes_(mes, anio) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, 13).getValues();
  var gastos = [];
  values.forEach(function (r) {
    var fecha = r[0];
    if (fecha instanceof Date && fecha.getMonth() + 1 === mes && fecha.getFullYear() === anio) {
      gastos.push(filaAGasto_(r));
    }
  });
  gastos.reverse();
  return gastos;
}

function filaAGasto_(r) {
  return {
    fecha: r[0], descripcion: r[1], comercio: r[2], categoria: r[3],
    valor: r[4], estado: r[5], notas: r[6], fotoUrl: r[8], obra: r[10], id: r[11],
    nit: r[12],
  };
}

function obtenerObras_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
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

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
