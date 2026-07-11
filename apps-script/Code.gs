// ID de la carpeta de Drive donde se guardan las fotos de las facturas.
var FOLDER_ID = "1D8FpmwzMobg4z6_6tYFuaPEqSAWYy730";

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var fecha = body.fecha;
    var descripcion = body.descripcion || "";
    var comercio = body.comercio || "";
    var categoria = body.categoria || "";
    var valor = body.valor || 0;
    var notas = body.notas || "";

    var folder = DriveApp.getFolderById(FOLDER_ID);
    var decoded = Utilities.base64Decode(body.fotoBase64);
    var blob = Utilities.newBlob(decoded, body.fotoMimeType, body.fotoNombre);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var fileId = file.getId();
    var thumbnailUrl = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w800";
    var viewUrl = "https://drive.google.com/file/d/" + fileId + "/view";

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    sheet.appendRow([
      fecha, descripcion, comercio, categoria, valor, "Pendiente revision", notas,
      '=IMAGE("' + thumbnailUrl + '")',
      '=HYPERLINK("' + viewUrl + '","Ver factura")',
      viewUrl,
      new Date().toISOString()
    ]);

    return ContentService.createTextOutput(JSON.stringify({
      ok: true, fecha: fecha, descripcion: descripcion, comercio: comercio,
      categoria: categoria, valor: valor, notas: notas, fotoUrl: viewUrl
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return ContentService.createTextOutput(JSON.stringify([])).setMimeType(ContentService.MimeType.JSON);
    }
    var numRows = Math.min(30, lastRow - 1);
    var startRow = lastRow - numRows + 1;
    var values = sheet.getRange(startRow, 1, numRows, 10).getValues();
    var gastos = values.map(function (r) {
      return {
        fecha: r[0], descripcion: r[1], comercio: r[2], categoria: r[3],
        valor: r[4], estado: r[5], notas: r[6], fotoUrl: r[9]
      };
    }).reverse();
    return ContentService.createTextOutput(JSON.stringify(gastos)).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
