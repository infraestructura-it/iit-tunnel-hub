# Dependencias incluidas (vendorizadas)

El hub no usa `npm install`: estas librerías se copian aquí para el **cliente SSH** de las sesiones
remotas del navegador (`src/remote.js`). Solo se incluye el código de ejecución y su licencia.

| Paquete | Versión | Licencia | Uso |
|---|---|---|---|
| ssh2 | 1.17.0 | MIT | Cliente SSH (sin el módulo nativo opcional) |
| asn1 | 0.2.6 | MIT | Dependencia de ssh2 |
| bcrypt-pbkdf | 1.0.2 | BSD-3-Clause | Dependencia de ssh2 (claves cifradas) |
| safer-buffer | 2.1.2 | MIT | Dependencia de asn1 |
| tweetnacl | 0.14.5 | Unlicense | Dependencia de bcrypt-pbkdf |

Cambio respecto del original: los `require('<paquete>')` entre ellas se reescribieron a rutas relativas
(`require('../../asn1')`, etc.), porque no viven en una carpeta `node_modules` (actualizar.ps1 y .gitignore la excluyen).

En el navegador (`public/vendor/`): noVNC 1.7.0 (MPL-2.0) en `novnc/`, xterm.js 6.0.0 y @xterm/addon-fit 0.11.0 (MIT) en `xterm/`.

Para actualizar: `npm pack` de cada paquete, copiar `lib/` (o el archivo principal), `package.json` y `LICENSE`,
y volver a aplicar el cambio de los `require`. Luego `./test/e2e.sh` (sección de sesiones remotas).
