# Gastos JACBEL

App web para registrar gastos de la empresa desde el iPhone: escribes (o dictas) qué te gastaste,
adjuntas la foto de la factura, y una IA (Claude) lee la factura y agrega la fila automáticamente
a un Google Sheet para tu contadora — incluida la foto de la factura.

## Qué necesitas configurar antes de usarla (una sola vez)

### 1. El Google Sheet (ya creado)
Ya está creado en tu Drive: **[Gastos JACBEL](https://docs.google.com/spreadsheets/d/1GPa1e_QvI02Ehr_6-Yity-Je3Ymcn1txhC-fCGnGAzo/edit)**
con los encabezados: `Fecha | Descripcion | Comercio | Categoria | Valor | Estado | Notas | Foto | Ver Factura | Foto URL | Registrado`

### 2. La carpeta de Drive para las fotos (ya creada)
Ya está creada: **[Facturas Gastos JACBEL](https://drive.google.com/drive/folders/1D8FpmwzMobg4z6_6tYFuaPEqSAWYy730)**
(ID: `1D8FpmwzMobg4z6_6tYFuaPEqSAWYy730`, ya está puesto en el código de Apps Script del paso siguiente).

### 3. Conecta el Sheet con Apps Script (5 min, sin tarjeta ni Google Cloud)
1. Abre tu [Google Sheet](https://docs.google.com/spreadsheets/d/1GPa1e_QvI02Ehr_6-Yity-Je3Ymcn1txhC-fCGnGAzo/edit).
2. Menú "**Extensiones**" → "**Apps Script**". Se abre un editor de código en una pestaña nueva.
3. Borra todo el código de ejemplo que aparece (`function myFunction() {...}`).
4. Pega el contenido completo del archivo [`apps-script/Code.gs`](apps-script/Code.gs) de esta carpeta.
5. Arriba, dale clic al ícono de guardar (💾) o `Cmd+S`.
6. Botón azul "**Implementar**" (Deploy) → "**Nueva implementación**" (New deployment).
7. Junto a "Seleccionar tipo" haz clic en el ⚙️ y elige "**Aplicación web**" (Web app).
8. Configura:
   - Descripción: `Gastos JACBEL API`
   - Ejecutar como: **Yo (tu correo)**
   - Quién tiene acceso: **Cualquier usuario** (Anyone)
9. Clic en "**Implementar**". Te va a pedir autorizar permisos (es tu propia cuenta accediendo a tu propio Sheet/Drive, es normal) → "Autorizar acceso" → elige tu cuenta → puede que veas una pantalla de advertencia de Google ("Google no verificó esta app") → clic en "Avanzado" → "Ir a Gastos JACBEL API (no seguro)". Esto es seguro: la "app" eres tú mismo, Google solo avisa porque el script no está publicado en una tienda.
10. Copia la **URL de la aplicación web** que te muestra (termina en `/exec`). Esa es tu `APPS_SCRIPT_URL`.

### 4. Consigue tu API key de Anthropic
1. Ve a [console.anthropic.com](https://console.anthropic.com) → "API Keys" → crea una nueva.
2. Guárdala, la vas a necesitar en el paso de despliegue (`ANTHROPIC_API_KEY`). Ten en cuenta que cada
   factura leída tiene un costo pequeño (unos centavos) que se cobra a esa cuenta.

### 5. Despliega el backend (Render, gratis para este uso)
1. Sube esta carpeta `gastos-app` a un repositorio de GitHub (puedo ayudarte con esto si quieres).
2. Ve a [render.com](https://render.com), crea una cuenta gratuita y conecta tu repositorio de GitHub.
3. Crea un "New Web Service" apuntando a este repo, con:
   - **Root directory:** `backend`
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. En la sección "Environment", agrega estas variables:
   - `ANTHROPIC_API_KEY` (paso 4)
   - `APPS_SCRIPT_URL` (paso 3)
5. Despliega. Render te da una URL tipo `https://gastos-jacbel.onrender.com` — esa es tu app.

### 6. Instálala en tu iPhone
1. Abre esa URL en Safari (no en Chrome, tiene que ser Safari para que funcione "Agregar a inicio").
2. Toca el botón de compartir (el cuadro con la flecha hacia arriba) → "Agregar a pantalla de inicio".
3. Listo: te queda un ícono como app normal. Ábrela, toca el botón **+**, escribe o dicta el gasto
   (usando el micrófono del teclado), toma la foto de la factura y guarda.

## Notas
- El plan gratuito de Render "duerme" el servidor tras un rato sin uso; la primera apertura del día
  puede tardar unos 20-30 segundos en responder mientras despierta. Si eso te molesta, se puede pasar
  a un plan pago (~$7/mes) para que esté siempre activo.
- Cada gasto queda como "Pendiente revisión" en la columna Estado — revisa de vez en cuando que la IA
  haya leído bien el valor y el comercio antes de entregarle la hoja a tu contadora.
- Cada foto de factura se sube a la carpeta de Drive del paso 2 y queda con enlace "cualquiera con el
  link puede ver" — esto es necesario para que la miniatura se vea dentro de la celda de Google Sheets
  (columna Foto) con la función IMAGE(). La foto no aparece listada públicamente en ningún buscador,
  solo es accesible para quien tenga el link exacto.
- Si algún día cambias el ID de la carpeta de Drive, actualiza la constante `FOLDER_ID` al inicio de
  `apps-script/Code.gs`, guarda, y vuelve a implementar (Implementar → Gestionar implementaciones →
  editar → Nueva versión).
