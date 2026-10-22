# Agente de pantalla — seguimiento de escritorio en vivo (Windows)

Este paquete actualiza el agente propio de captura de pantalla para que
funcione en equipos que están en la pantalla de inicio de sesión / bloqueo
(como BIOMETRICO) y siga el cambio de escritorio cuando el usuario entra.

## Qué cambia

- **Seguimiento de escritorio en vivo** (`agente/pantalla_windows.go`): en cada
  captura el agente vuelve a engancharse al escritorio de entrada actual
  (`OpenInputDesktop` + `SetThreadDesktop`). Si el escritorio cambió
  (Winlogon → escritorio del usuario, UAC, bloqueo), suelta y recrea el GDI
  automáticamente, sin reconectar.
- Corriendo como **SYSTEM** (instalación como administrador), el agente ahora
  **sí muestra la pantalla de inicio de sesión de Windows** y transiciona solo
  al escritorio del usuario cuando éste inicia sesión. Ya no aparece el negro
  "Pantalla protegida" en la pantalla de login.
- `blocked()` solo reporta "pantalla protegida" cuando realmente no logra
  engancharse al escritorio de entrada (típico de un agente por-usuario sin
  SYSTEM frente a UAC). Como SYSTEM se engancha a todo y no bloquea.

## Cómo aplicar

1. En el hub (`C:\ITT\iit-tunnel-hub`):
   `.\actualizar.ps1 -Zip C:\Descargas\iit-tunnel-hub-pantalla-escritorio.zip`
   luego `git add -A; git commit; git pull --rebase; git push`.
   Relanza el hub con `iniciar-local.mio.ps1` (no el .ps1 de 127.0.0.1).
2. En BIOMETRICO: **reinstala el agente como administrador** (el instalador
   crea la tarea SYSTEM "IIT agente"). El agente se bajará actualizado desde
   `/descargas/iit-agente-windows-amd64.exe`.
3. Abre la máquina en el panel → "🖥 Pantalla (agente)". Verás la pantalla de
   login y, al iniciar sesión el usuario, el escritorio real con ratón y teclado.
