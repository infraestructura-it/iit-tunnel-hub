package main

// Compartir pantalla desde el agente (como AnyDesk/RustDesk, pero propio y por el canal WebRTC del hub).
//
// El agente captura la pantalla del equipo, la parte en mosaicos de 128×128 px, y manda por el canal de datos
// "pantalla" solo los mosaicos que cambian (JPEG). El navegador los dibuja en un <canvas>. En sentido inverso,
// el navegador manda ratón, teclado, rueda y portapapeles, que el agente inyecta en el sistema (SendInput).
//
// La captura y la inyección dependen del sistema: la implementación real está en pantalla_windows.go; en Linux
// se usa una pantalla sintética (pantalla_linux.go) para las pruebas de punta a punta. El protocolo y la lógica
// de mosaicos viven aquí y son iguales en los dos.

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/jpeg"
	"log"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	tileSize   = 128             // lado del mosaico en píxeles
	jpegQ      = 82              // calidad JPEG de cada mosaico (texto nítido; WebRTC directo tiene ancho de banda de sobra)
	maxFPS     = 15              // cuadros por segundo máximos
	minFrameMs = 1000 / maxFPS   // ms mínimos entre cuadros
	bpHigh     = 2 * 1024 * 1024 // si el buffer del canal supera esto, se espera (contrapresión)
)

// Opcodes agente → navegador (primer byte del mensaje binario)
const (
	opInit  = 'I' // JSON {w,h}: tamaño de la pantalla en píxeles
	opTile  = 'T' // [x u16][y u16][w u16][h u16] + JPEG del rectángulo
	opBlock = 'B' // UTF-8: el escritorio no se puede capturar (bloqueo, UAC); el navegador lo muestra
	opClip  = 'K' // UTF-8: texto que se copió en el equipo
)

// Opcodes navegador → agente
const (
	opMove  = 'm' // [x u16][y u16] mover el ratón (coordenadas absolutas de pantalla)
	opDown  = 'd' // [button u8][x u16][y u16] botón presionado (0 izq, 1 medio, 2 der)
	opUp    = 'u' // [button u8][x u16][y u16] botón soltado
	opWheel = 'w' // [dy i16][x u16][y u16] rueda
	opKey   = 'k' // [state u8 (1 abajo)][scancode u16][extended u8] tecla (por scancode, respeta la distribución)
	opPaste = 'p' // UTF-8: poner este texto en el portapapeles del equipo
	opFresh = 'r' // pedir el cuadro completo otra vez
)

// capture es lo que cambia por sistema (Windows real, Linux sintético para pruebas).
type capture interface {
	size() (w, h int)
	grab(dst *image.RGBA) error // llena dst (del tamaño de la pantalla) con la imagen actual
	moveMouse(x, y int)
	button(btn int, down bool, x, y int)
	wheel(dy, x, y int)
	key(scancode int, down, extended bool)
	clipboardGet() (string, bool)
	clipboardSet(s string)
	blocked() (bool, string) // escritorio seguro / bloqueado
	close()
}

// pantalla atiende una sesión de compartir pantalla sobre un canal de datos ya abierto.
func (s *session) pantalla(dc *webrtc.DataChannel) {
	cap, err := newCapture()
	if err != nil {
		s.send(msg{Type: "error", ID: s.id, Message: "no se pudo iniciar la captura: " + err.Error()})
		_ = dc.Close()
		s.close()
		return
	}
	defer cap.close()
	w, h := cap.size()
	log.Printf("sesión %s: pantalla %dx%d", s.id, w, h)

	dc.SetBufferedAmountLowThreshold(512 * 1024)
	low := make(chan struct{}, 1)
	dc.OnBufferedAmountLow(func() {
		select {
		case low <- struct{}{}:
		default:
		}
	})

	// Entrada del navegador: se procesa en la gorutina del canal (no bloquea la captura)
	dc.OnMessage(func(m webrtc.DataChannelMessage) { s.entrada(cap, m.Data) })
	refresh := make(chan struct{}, 1)
	s.refresh = refresh
	dc.OnClose(func() { s.close() })

	// Marco de init
	initJSON, _ := json.Marshal(map[string]int{"w": w, "h": h})
	_ = dc.Send(append([]byte{opInit}, initJSON...))
	s.send(msg{Type: "estado", ID: s.id, Estado: "abierto"})

	cur := image.NewRGBA(image.Rect(0, 0, w, h))
	cols := (w + tileSize - 1) / tileSize
	rows := (h + tileSize - 1) / tileSize
	sums := make([]uint32, cols*rows) // crc del último mosaico enviado
	first := true
	var out int64
	var lastClip string

	ticker := time.NewTicker(minFrameMs * time.Millisecond)
	defer ticker.Stop()
	clipT := time.NewTicker(1500 * time.Millisecond)
	defer clipT.Stop()

	for {
		select {
		case <-s.closed:
			s.send(msg{Type: "estado", ID: s.id, Estado: "cerrado", BytesIn: out})
			log.Printf("sesión %s: pantalla cerrada (%d B al navegador)", s.id, out)
			return
		case <-clipT.C:
			if t, ok := cap.clipboardGet(); ok && t != lastClip && len(t) < 256*1024 {
				lastClip = t
				_ = dc.Send(append([]byte{opClip}, []byte(t)...))
			}
			continue
		case <-refresh:
			first = true
			continue
		case <-ticker.C:
		}

		if b, text := cap.blocked(); b {
			_ = dc.Send(append([]byte{opBlock}, []byte(text)...))
			first = true // al volver, cuadro completo
			continue
		}
		if err := cap.grab(cur); err != nil {
			continue
		}
		// Contrapresión: si el canal va saturado, se salta este cuadro
		if dc.BufferedAmount() > bpHigh {
			select {
			case <-low:
			case <-time.After(200 * time.Millisecond):
			}
			continue
		}

		n := enviarMosaicos(dc, cur, sums, cols, rows, w, h, first)
		out += int64(n)
		first = false
	}
}

// enviarMosaicos manda los mosaicos cuyo contenido cambió (o todos si full). Devuelve bytes enviados.
func enviarMosaicos(dc *webrtc.DataChannel, img *image.RGBA, sums []uint32, cols, rows, w, h int, full bool) int {
	var sent int
	var buf bytes.Buffer
	for ty := 0; ty < rows; ty++ {
		for tx := 0; tx < cols; tx++ {
			x0, y0 := tx*tileSize, ty*tileSize
			x1, y1 := min(x0+tileSize, w), min(y0+tileSize, h)
			r := image.Rect(x0, y0, x1, y1)
			sum := crcTile(img, r)
			idx := ty*cols + tx
			if !full && sums[idx] == sum {
				continue
			}
			sums[idx] = sum
			buf.Reset()
			buf.WriteByte(opTile)
			var hdr [8]byte
			binary.BigEndian.PutUint16(hdr[0:], uint16(x0))
			binary.BigEndian.PutUint16(hdr[2:], uint16(y0))
			binary.BigEndian.PutUint16(hdr[4:], uint16(x1-x0))
			binary.BigEndian.PutUint16(hdr[6:], uint16(y1-y0))
			buf.Write(hdr[:])
			if err := jpeg.Encode(&buf, img.SubImage(r), &jpeg.Options{Quality: jpegQ}); err != nil {
				continue
			}
			if err := dc.Send(buf.Bytes()); err != nil {
				return sent
			}
			sent += buf.Len()
		}
	}
	return sent
}

func crcTile(img *image.RGBA, r image.Rectangle) uint32 {
	h := crc32.NewIEEE()
	for y := r.Min.Y; y < r.Max.Y; y++ {
		o := img.PixOffset(r.Min.X, y)
		h.Write(img.Pix[o : o+(r.Dx()*4)])
	}
	return h.Sum32()
}

// entrada procesa un mensaje del navegador (ratón, teclado, portapapeles, refresco).
func (s *session) entrada(cap capture, b []byte) {
	if len(b) < 1 {
		return
	}
	u16 := func(o int) int { return int(binary.BigEndian.Uint16(b[o:])) }
	switch b[0] {
	case opMove:
		if len(b) >= 5 {
			cap.moveMouse(u16(1), u16(3))
		}
	case opDown, opUp:
		if len(b) >= 6 {
			cap.button(int(b[1]), b[0] == opDown, u16(2), u16(4))
		}
	case opWheel:
		if len(b) >= 7 {
			cap.wheel(int(int16(binary.BigEndian.Uint16(b[1:]))), u16(3), u16(5))
		}
	case opKey:
		if len(b) >= 5 {
			cap.key(u16(2), b[1] == 1, b[4] == 1)
		}
	case opPaste:
		if len(b) <= 256*1024 {
			cap.clipboardSet(string(b[1:]))
		}
	case opFresh:
		select {
		case s.refresh <- struct{}{}:
		default:
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// capacidades anuncia al hub lo que el agente puede hacer además del puente VNC.
func capacidades() []string {
	if tieneCapturaPantalla() {
		return []string{"pantalla"}
	}
	return nil
}
