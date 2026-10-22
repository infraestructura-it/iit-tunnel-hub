//go:build windows

package main

// Captura de pantalla e inyección de entrada en Windows, con las APIs del sistema (GDI y SendInput).
// Corre en la sesión del usuario conectado. En el escritorio seguro (UAC, pantalla de bloqueo) la captura
// sale en negro; se detecta y se avisa al navegador en vez de mostrar una pantalla falsa.

import (
	"fmt"
	"image"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pGetSystemMetrics            = user32.NewProc("GetSystemMetrics")
	pGetDC                       = user32.NewProc("GetDC")
	pReleaseDC                   = user32.NewProc("ReleaseDC")
	pSendInput                   = user32.NewProc("SendInput")
	pSetProcessDPIAware          = user32.NewProc("SetProcessDPIAware")
	pSetProcessDpiAwarenessCtx   = user32.NewProc("SetProcessDpiAwarenessContext")
	pOpenInputDesktop            = user32.NewProc("OpenInputDesktop")
	pGetUserObjectInformationW   = user32.NewProc("GetUserObjectInformationW")
	pCloseDesktop                = user32.NewProc("CloseDesktop")
	pOpenClipboard               = user32.NewProc("OpenClipboard")
	pCloseClipboard              = user32.NewProc("CloseClipboard")
	pGetClipboardData            = user32.NewProc("GetClipboardData")
	pSetClipboardData            = user32.NewProc("SetClipboardData")
	pEmptyClipboard              = user32.NewProc("EmptyClipboard")

	pCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	pCreateDIBSection       = gdi32.NewProc("CreateDIBSection")
	pSelectObject           = gdi32.NewProc("SelectObject")
	pBitBlt                 = gdi32.NewProc("BitBlt")
	pDeleteObject           = gdi32.NewProc("DeleteObject")
	pDeleteDC               = gdi32.NewProc("DeleteDC")

	pGlobalAlloc  = kernel32.NewProc("GlobalAlloc")
	pGlobalLock   = kernel32.NewProc("GlobalLock")
	pGlobalUnlock = kernel32.NewProc("GlobalUnlock")
)

const (
	smXVirtual  = 76
	smYVirtual  = 77
	smCXVirtual = 78
	smCYVirtual = 79

	srccopy    = 0x00CC0020
	captureblt = 0x40000000
	biRGB      = 0

	inputMouse    = 0
	inputKeyboard = 1

	meMove       = 0x0001
	meLeftDown   = 0x0002
	meLeftUp     = 0x0004
	meRightDown  = 0x0008
	meRightUp    = 0x0010
	meMidDown    = 0x0020
	meMidUp      = 0x0040
	meWheel      = 0x0800
	meAbsolute   = 0x8000
	meVirtualDsk = 0x4000

	keUp        = 0x0002
	keScancode  = 0x0008
	keExtended  = 0x0001
	wheelDelta  = 120

	cfUnicodeText = 13
	gmemMoveable  = 0x0002
	uoiName       = 2
)

func tieneCapturaPantalla() bool { return true }

type winCap struct {
	vx, vy, w, h int
	screenDC     uintptr
	memDC        uintptr
	bitmap       uintptr
	bits         unsafe.Pointer
	stride       int
}

func metric(i int) int {
	r, _, _ := pGetSystemMetrics.Call(uintptr(i))
	return int(int32(r))
}

func newCapture() (capture, error) {
	// DPI: coordenadas en píxeles físicos (si no, en pantallas escaladas se captura recortado)
	if pSetProcessDpiAwarenessCtx.Find() == nil {
		pSetProcessDpiAwarenessCtx.Call(^uintptr(3)) // PER_MONITOR_AWARE_V2 (-4)
	} else {
		pSetProcessDPIAware.Call()
	}
	c := &winCap{
		vx: metric(smXVirtual), vy: metric(smYVirtual),
		w: metric(smCXVirtual), h: metric(smCYVirtual),
	}
	if c.w <= 0 || c.h <= 0 {
		return nil, fmt.Errorf("no se pudo leer el tamaño de la pantalla")
	}
	sdc, _, _ := pGetDC.Call(0)
	if sdc == 0 {
		return nil, fmt.Errorf("GetDC falló")
	}
	c.screenDC = sdc
	mdc, _, _ := pCreateCompatibleDC.Call(sdc)
	c.memDC = mdc

	// BITMAPINFOHEADER 32bpp, alto negativo = top-down
	var bi struct {
		Size                   uint32
		Width, Height          int32
		Planes, BitCount       uint16
		Compression, SizeImage uint32
		XPPM, YPPM             int32
		ClrUsed, ClrImportant  uint32
	}
	bi.Size = uint32(unsafe.Sizeof(bi))
	bi.Width = int32(c.w)
	bi.Height = -int32(c.h)
	bi.Planes = 1
	bi.BitCount = 32
	bi.Compression = biRGB
	var bits unsafe.Pointer
	hbm, _, _ := pCreateDIBSection.Call(mdc, uintptr(unsafe.Pointer(&bi)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if hbm == 0 || bits == nil {
		c.close()
		return nil, fmt.Errorf("CreateDIBSection falló")
	}
	c.bitmap = hbm
	c.bits = bits
	c.stride = c.w * 4
	pSelectObject.Call(mdc, hbm)
	return c, nil
}

func (c *winCap) size() (int, int) { return c.w, c.h }

func (c *winCap) grab(dst *image.RGBA) error {
	r, _, _ := pBitBlt.Call(c.memDC, 0, 0, uintptr(c.w), uintptr(c.h), c.screenDC, uintptr(int32(c.vx)), uintptr(int32(c.vy)), srccopy|captureblt)
	if r == 0 {
		return fmt.Errorf("BitBlt falló")
	}
	// DIB es BGRA top-down; image.RGBA quiere RGBA. Se copia fila por fila intercambiando B y R.
	src := unsafe.Slice((*byte)(c.bits), c.h*c.stride)
	for y := 0; y < c.h; y++ {
		so := y * c.stride
		do := dst.PixOffset(0, y)
		for x := 0; x < c.w; x++ {
			s := so + x*4
			d := do + x*4
			dst.Pix[d+0] = src[s+2] // R
			dst.Pix[d+1] = src[s+1] // G
			dst.Pix[d+2] = src[s+0] // B
			dst.Pix[d+3] = 255
		}
	}
	return nil
}

// --- inyección de entrada (SendInput) ---

type mouseInput struct {
	dx, dy      int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}
type keybdInput struct {
	wVk, wScan  uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}
type inputT struct {
	typ uint32
	_   uint32
	u   [32]byte // unión MOUSEINPUT/KEYBDINPUT (amd64)
}

func sendInput(in *inputT) {
	pSendInput.Call(1, uintptr(unsafe.Pointer(in)), unsafe.Sizeof(*in))
}

// norma convierte un píxel (ya relativo al origen del escritorio virtual) a 0..65535.
func (c *winCap) norma(x, y int) (int32, int32) {
	den := func(n int) int { if n > 1 { return n - 1 }; return 1 }
	return int32(x * 65535 / den(c.w)), int32(y * 65535 / den(c.h))
}

func (c *winCap) mouseEvent(flags uint32, data uint32, x, y int) {
	var in inputT
	in.typ = inputMouse
	nx, ny := c.norma(x, y)
	mi := (*mouseInput)(unsafe.Pointer(&in.u[0]))
	mi.dx, mi.dy = nx, ny
	mi.mouseData = data
	mi.dwFlags = flags | meAbsolute | meVirtualDsk
	sendInput(&in)
}

func (c *winCap) moveMouse(x, y int) { c.mouseEvent(meMove, 0, x, y) }

func (c *winCap) button(btn int, down bool, x, y int) {
	var f uint32
	switch btn {
	case 0:
		f = pick(down, meLeftDown, meLeftUp)
	case 1:
		f = pick(down, meMidDown, meMidUp)
	case 2:
		f = pick(down, meRightDown, meRightUp)
	default:
		return
	}
	c.mouseEvent(meMove|f, 0, x, y)
}

func (c *winCap) wheel(dy, x, y int) {
	c.mouseEvent(meWheel, uint32(int32(dy*wheelDelta)), x, y)
}

func (c *winCap) key(scancode int, down, extended bool) {
	var in inputT
	in.typ = inputKeyboard
	ki := (*keybdInput)(unsafe.Pointer(&in.u[0]))
	ki.wScan = uint16(scancode)
	ki.dwFlags = keScancode
	if extended {
		ki.dwFlags |= keExtended
	}
	if !down {
		ki.dwFlags |= keUp
	}
	sendInput(&in)
}

func pick(b bool, t, f uint32) uint32 {
	if b {
		return t
	}
	return f
}

// --- portapapeles de texto ---

func (c *winCap) clipboardGet() (string, bool) {
	if r, _, _ := pOpenClipboard.Call(0); r == 0 {
		return "", false
	}
	defer pCloseClipboard.Call()
	h, _, _ := pGetClipboardData.Call(cfUnicodeText)
	if h == 0 {
		return "", false
	}
	p, _, _ := pGlobalLock.Call(h)
	if p == 0 {
		return "", false
	}
	defer pGlobalUnlock.Call(h)
	// UTF-16 terminado en 0
	var u16 []uint16
	for i := 0; ; i++ {
		ch := *(*uint16)(unsafe.Pointer(p + uintptr(i*2)))
		if ch == 0 {
			break
		}
		u16 = append(u16, ch)
		if len(u16) > 512*1024 {
			break
		}
	}
	return syscall.UTF16ToString(u16), true
}

func (c *winCap) clipboardSet(s string) {
	u16, err := syscall.UTF16FromString(s)
	if err != nil {
		return
	}
	if r, _, _ := pOpenClipboard.Call(0); r == 0 {
		return
	}
	defer pCloseClipboard.Call()
	pEmptyClipboard.Call()
	n := uintptr(len(u16) * 2)
	hMem, _, _ := pGlobalAlloc.Call(gmemMoveable, n)
	if hMem == 0 {
		return
	}
	p, _, _ := pGlobalLock.Call(hMem)
	if p == 0 {
		return
	}
	for i, ch := range u16 {
		*(*uint16)(unsafe.Pointer(p + uintptr(i*2))) = ch
	}
	pGlobalUnlock.Call(hMem)
	pSetClipboardData.Call(cfUnicodeText, hMem)
}

// blocked: en el escritorio seguro (UAC, bloqueo) el escritorio de entrada no es "Default".
func (c *winCap) blocked() (bool, string) {
	h, _, _ := pOpenInputDesktop.Call(0, 0, 0x0001 /*DESKTOP_READOBJECTS*/)
	if h == 0 {
		return true, "El equipo está en una pantalla protegida de Windows (control de cuentas de usuario o bloqueo). La verás cuando el usuario la cierre."
	}
	defer pCloseDesktop.Call(h)
	var buf [64]uint16
	var need uint32
	pGetUserObjectInformationW.Call(h, uoiName, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)*2), uintptr(unsafe.Pointer(&need)))
	name := syscall.UTF16ToString(buf[:])
	if name != "" && name != "Default" {
		return true, "El equipo está en una pantalla protegida de Windows (" + name + "). La verás cuando el usuario la cierre."
	}
	return false, ""
}

func (c *winCap) close() {
	if c.bitmap != 0 {
		pDeleteObject.Call(c.bitmap)
	}
	if c.memDC != 0 {
		pDeleteDC.Call(c.memDC)
	}
	if c.screenDC != 0 {
		pReleaseDC.Call(0, c.screenDC)
	}
}
