//go:build !windows

package main

// Fuera de Windows el agente no captura pantalla propia (en Raspberry/Linux la pantalla va por VNC).
// Para las pruebas de punta a punta se habilita una pantalla SINTÉTICA con IIT_AGENTE_PANTALLA_TEST=1:
// dibuja un reloj y un cursor que se mueve con lo que manda el navegador, y registra la última entrada.

import (
	"image"
	"image/color"
	"os"
	"sync"
	"time"
)

func tieneCapturaPantalla() bool { return os.Getenv("IIT_AGENTE_PANTALLA_TEST") == "1" }

func diagPantalla() { println("diagnóstico de pantalla: solo en Windows") }

func newCapture() (capture, error) {
	return &fakeCap{w: 800, h: 480, mx: 400, my: 240, start: time.Now(), clip: "equipo-de-prueba"}, nil
}

type fakeCap struct {
	mu            sync.Mutex
	w, h          int
	mx, my        int
	lastBtn       int
	lastKey       int
	lastDown      bool
	start         time.Time
	clip          string
	pasted        string
}

func (c *fakeCap) size() (int, int) { return c.w, c.h }

func (c *fakeCap) grab(dst *image.RGBA) error {
	c.mu.Lock()
	mx, my := c.mx, c.my
	c.mu.Unlock()
	// Fondo que cambia cada segundo (para que haya mosaicos nuevos) y un cuadro en la posición del cursor
	band := int(time.Since(c.start).Seconds()) % 3
	bg := []color.RGBA{{20, 30, 48, 255}, {30, 20, 48, 255}, {20, 48, 30, 255}}[band]
	for y := 0; y < c.h; y++ {
		for x := 0; x < c.w; x++ {
			dst.SetRGBA(x, y, bg)
		}
	}
	// "cursor": cuadro claro de 16x16 en (mx,my)
	for y := my - 8; y < my+8; y++ {
		for x := mx - 8; x < mx+8; x++ {
			if x >= 0 && x < c.w && y >= 0 && y < c.h {
				dst.SetRGBA(x, y, color.RGBA{230, 240, 255, 255})
			}
		}
	}
	return nil
}

func (c *fakeCap) moveMouse(x, y int) { c.mu.Lock(); c.mx, c.my = x, y; c.mu.Unlock() }
func (c *fakeCap) button(btn int, down bool, x, y int) {
	c.mu.Lock()
	c.lastBtn, c.lastDown, c.mx, c.my = btn, down, x, y
	c.mu.Unlock()
}
func (c *fakeCap) wheel(dy, x, y int)                   {}
func (c *fakeCap) key(scancode int, down, extended bool) { c.mu.Lock(); c.lastKey, c.lastDown = scancode, down; c.mu.Unlock() }
func (c *fakeCap) clipboardGet() (string, bool)         { c.mu.Lock(); defer c.mu.Unlock(); return c.clip, true }
func (c *fakeCap) clipboardSet(s string)                { c.mu.Lock(); c.pasted = s; c.mu.Unlock() }
func (c *fakeCap) blocked() (bool, string)              { return false, "" }
func (c *fakeCap) close()                               {}
